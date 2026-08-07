/**
 * Screen Companion — light, minimal OpenCluely-style workspace.
 * Wired to Clyra RapidOCR + optional Electron overlay / guide / control.
 */
import { useCallback, useState } from "react";
import {
  ArrowUp,
  Eye,
  Mic,
  MonitorSmartphone,
  MousePointer2,
  Sparkles,
  Target,
} from "lucide-react";
import { cn } from "../lib/utils";
import { getElectronDesktop } from "../lib/electron-runtime";
import { VoiceWaveform } from "./voice/VoiceWaveform";

type Message = { id: string; role: "user" | "assistant" | "system"; text: string; vision?: string };

function speakReply(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text.replace(/[`*_#]/g, " ").slice(0, 600));
  utter.rate = 1.02;
  utter.pitch = 1;
  utter.volume = 0.96;
  window.speechSynthesis.speak(utter);
}

export default function ScreenCompanionWorkspace() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"talk" | "message">("message");
  const [demoMode, setDemoMode] = useState<"off" | "guide" | "ai" | "user">("off");
  const [pointer, setPointer] = useState<{ x: number; y: number; label: string } | null>(null);
  const [listeningDemo, setListeningDemo] = useState(false);
  const desktop = getElectronDesktop();

  const ask = useCallback(async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text: question }]);
    setBusy(true);
    try {
      const response = await fetch("/api/companion/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const payload = await response.json();
      const text = String(
        payload.text || payload?.choices?.[0]?.message?.content || payload.error || "No reply",
      );
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text }]);
      if (/\b(where|point|show me|click|press|tap|guide|screen)\b/i.test(question)) {
        setDemoMode("guide");
        setPointer({ x: 58, y: 42, label: "Look here" });
      }
      if (mode === "talk") speakReply(text);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: error instanceof Error ? error.message : "Companion failed",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }, [busy, input, mode]);

  return (
    <div
      className="companion-shell relative flex h-full min-h-0 overflow-hidden bg-[color:var(--clyra-canvas,#f4f5f7)]"
      style={{
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        backgroundImage:
          "radial-gradient(900px 420px at 50% 0%, rgba(0,82,251,0.06), transparent 55%), radial-gradient(700px 360px at 100% 100%, rgba(15,23,42,0.03), transparent 50%)",
      }}
    >
      {/* Floating command pill — light glass */}
      <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center">
        <div className="pointer-events-auto flex h-9 items-center gap-0.5 rounded-full border border-[color:var(--clyra-border,#e5e7eb)] bg-white/90 px-1.5 text-[11.5px] font-medium text-[color:var(--clyra-text,#111827)] shadow-[0_8px_28px_rgba(15,23,42,0.08)] backdrop-blur-xl">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[color:var(--clyra-text-secondary,#6b7280)] transition-colors hover:bg-[color:var(--clyra-hover,#f3f4f6)] hover:text-[color:var(--clyra-text,#111827)]"
            onClick={() => {
              setMessages((prev) => [
                ...prev,
                {
                  id: `s-${Date.now()}`,
                  role: "system",
                  text: "See screen uses RapidOCR in Electron. This web preview uses the same light UI.",
                },
              ]);
            }}
          >
            <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            See
          </button>
          <span className="h-3.5 w-px bg-[color:var(--clyra-border,#e5e7eb)]" />
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors hover:bg-[color:var(--clyra-hover,#f3f4f6)]",
              listeningDemo
                ? "text-[color:var(--clyra-accent,#0052fb)]"
                : "text-[color:var(--clyra-text-secondary,#6b7280)] hover:text-[color:var(--clyra-text,#111827)]",
            )}
            onClick={() => setListeningDemo((v) => !v)}
            aria-label="Toggle listening"
          >
            <Mic className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <span className="h-3.5 w-px bg-[color:var(--clyra-border,#e5e7eb)]" />
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
              demoMode === "guide"
                ? "bg-[color:var(--clyra-accent,#0052fb)]/10 text-[color:var(--clyra-accent,#0052fb)]"
                : "text-[color:var(--clyra-text-secondary,#6b7280)] hover:bg-[color:var(--clyra-hover,#f3f4f6)] hover:text-[color:var(--clyra-text,#111827)]",
            )}
            onClick={() => {
              setDemoMode("guide");
              setPointer({ x: 62, y: 48, label: "Click here" });
              setMessages((prev) => [
                ...prev,
                {
                  id: `g-${Date.now()}`,
                  role: "assistant",
                  text: "Guide mode — I’m pointing at where to click. The ring is visual only; I have not taken control.",
                },
              ]);
            }}
          >
            <Target className="h-3.5 w-3.5" strokeWidth={1.75} />
            Guide
          </button>
          <span className="h-3.5 w-px bg-[color:var(--clyra-border,#e5e7eb)]" />
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
              demoMode === "ai" || demoMode === "user"
                ? "bg-[color:var(--clyra-accent,#0052fb)]/10 text-[color:var(--clyra-accent,#0052fb)]"
                : "text-[color:var(--clyra-text-secondary,#6b7280)] hover:bg-[color:var(--clyra-hover,#f3f4f6)] hover:text-[color:var(--clyra-text,#111827)]",
            )}
            onClick={() => {
              setDemoMode("ai");
              setPointer({ x: 40, y: 55, label: "Working" });
            }}
          >
            <MousePointer2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Control
          </button>
          <span className="mx-1.5 h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]" />
        </div>
      </div>

      <aside className="relative z-10 m-5 mt-[4.25rem] flex w-[260px] shrink-0 flex-col rounded-[18px] border border-[color:var(--clyra-border,#e5e7eb)] bg-white/95 p-5 text-[color:var(--clyra-text,#111827)] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_rgba(15,23,42,0.05)]">
        <div className="text-[15px] font-semibold tracking-[-0.03em]">Clyra Companion</div>
        <p className="mt-1.5 text-[12px] leading-5 text-[color:var(--clyra-text-tertiary,#9ca3af)]">
          See your screen · Guide · optional Control
        </p>
        <div className="mt-5 flex gap-1 rounded-[12px] bg-[color:var(--clyra-surface-muted,#f3f4f6)] p-1">
          <button
            type="button"
            onClick={() => setMode("talk")}
            className={cn(
              "h-8 flex-1 rounded-[9px] text-[12px] font-medium transition-colors",
              mode === "talk"
                ? "bg-white text-[color:var(--clyra-text,#111827)] shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
                : "text-[color:var(--clyra-text-secondary,#6b7280)]",
            )}
          >
            Talk
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("message");
              if ("speechSynthesis" in window) window.speechSynthesis.cancel();
            }}
            className={cn(
              "h-8 flex-1 rounded-[9px] text-[12px] font-medium transition-colors",
              mode === "message"
                ? "bg-white text-[color:var(--clyra-text,#111827)] shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
                : "text-[color:var(--clyra-text-secondary,#6b7280)]",
            )}
          >
            Message
          </button>
        </div>
        <button
          type="button"
          onClick={() => void desktop?.companion?.toggle?.()}
          className="mt-3 flex h-10 items-center justify-center gap-2 rounded-[12px] border border-[color:var(--clyra-border,#e5e7eb)] bg-white text-[12.5px] font-medium text-[color:var(--clyra-text-secondary,#6b7280)] transition-colors hover:bg-[color:var(--clyra-hover,#f3f4f6)] hover:text-[color:var(--clyra-text,#111827)]"
        >
          <MonitorSmartphone className="h-4 w-4" strokeWidth={1.75} />
          {desktop ? "Open overlay" : "Desktop overlay"}
        </button>
        <ul className="mt-8 space-y-3 text-[12px] text-[color:var(--clyra-text-secondary,#6b7280)]">
          <li className="flex gap-2.5">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 text-[color:var(--clyra-accent,#0052fb)]" strokeWidth={1.75} />
            Chat with screen context
          </li>
          <li className="flex gap-2.5">
            <Eye className="mt-0.5 h-3.5 w-3.5 text-[color:var(--clyra-accent,#0052fb)]" strokeWidth={1.75} />
            RapidOCR vision
          </li>
          <li className="flex gap-2.5">
            <MousePointer2 className="mt-0.5 h-3.5 w-3.5 text-[color:var(--clyra-accent,#0052fb)]" strokeWidth={1.75} />
            Guide points · Control clicks
          </li>
        </ul>
      </aside>

      <main className="relative z-10 m-5 mt-[4.25rem] mr-5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-[color:var(--clyra-border,#e5e7eb)] bg-white/95 text-[color:var(--clyra-text,#111827)] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_rgba(15,23,42,0.05)]">
        <div className="flex items-center justify-between border-b border-[color:var(--clyra-border,#e5e7eb)] px-5 py-3.5">
          <div>
            <span className="text-[13.5px] font-semibold tracking-[-0.02em]">Chat</span>
            <span className="ml-2 text-[11px] text-[color:var(--clyra-text-tertiary,#9ca3af)]">Screen companion</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-5">
          {!messages.length && !busy ? (
            <div className="mx-auto flex min-h-[220px] max-w-[300px] flex-col items-center justify-center text-center">
              <div className="mb-4 grid h-11 w-11 place-items-center rounded-[14px] border border-[color:var(--clyra-border,#e5e7eb)] bg-[color:var(--clyra-surface-muted,#f8f9fb)]">
                <Eye className="h-5 w-5 text-[color:var(--clyra-accent,#0052fb)]" strokeWidth={1.75} />
              </div>
              <p className="text-[15px] font-semibold tracking-[-0.03em]">What’s on your screen?</p>
              <p className="mt-1.5 text-[12.5px] leading-5 text-[color:var(--clyra-text-tertiary,#9ca3af)]">
                Ask about anything you’re looking at. Guide can point without taking control.
              </p>
            </div>
          ) : null}
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex",
                message.role === "user" && "justify-end",
                message.role === "system" && "justify-center",
              )}
            >
              <div
                className={cn(
                  "max-w-[92%] text-[13px] leading-[1.55] tracking-[-0.01em]",
                  message.role === "user" &&
                    "rounded-[14px] bg-[color:var(--clyra-selected,#eef1f6)] px-3.5 py-2.5 text-[color:var(--clyra-text,#111827)]",
                  message.role === "assistant" && "pr-2 text-[color:var(--clyra-text,#111827)]",
                  message.role === "system" &&
                    "rounded-[10px] bg-[color:var(--clyra-surface-muted,#f3f4f6)] px-3 py-1.5 text-[11.5px] text-[color:var(--clyra-text-secondary,#6b7280)]",
                )}
              >
                {message.text}
              </div>
            </div>
          ))}
          {busy ? (
            <div className="flex items-center gap-2 text-[12.5px] text-[color:var(--clyra-text-tertiary,#9ca3af)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--clyra-accent,#0052fb)]" />
              Looking at your screen…
            </div>
          ) : null}
        </div>

        <div className="border-t border-[color:var(--clyra-border,#e5e7eb)] px-4 py-3">
          {listeningDemo ? (
            <div className="mb-2">
              <VoiceWaveform level={0.35} active compact />
            </div>
          ) : null}
          <div className="flex items-end gap-2 rounded-[14px] border border-[color:var(--clyra-border,#e5e7eb)] bg-[color:var(--clyra-surface-muted,#f8f9fb)] px-3 py-2">
            <textarea
              value={input}
              rows={2}
              placeholder={
                mode === "message"
                  ? "Ask what’s on your screen…"
                  : "Ask about your screen, or how to click something…"
              }
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void ask();
                }
              }}
              className="min-h-[40px] flex-1 resize-none bg-transparent text-[13.5px] text-[color:var(--clyra-text,#111827)] outline-none placeholder:text-[color:var(--clyra-text-tertiary,#9ca3af)]"
            />
            <button
              type="button"
              disabled={!input.trim() || busy}
              onClick={() => void ask()}
              aria-label="Send"
              className="mb-0.5 grid h-8 w-8 place-items-center rounded-full bg-[color:var(--clyra-accent,#0052fb)] text-white transition-opacity hover:opacity-95 disabled:bg-[color:var(--clyra-border,#e5e7eb)] disabled:text-[color:var(--clyra-text-tertiary,#9ca3af)]"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </main>

      {pointer && demoMode !== "off" ? (
        <div
          className="pointer-events-none absolute z-40"
          style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }}
          data-testid="companion-guide-cursor"
        >
          <div
            className={cn(
              "absolute -left-3.5 -top-3.5 h-9 w-9 rounded-full border-2",
              demoMode === "guide" ? "animate-ping border-[color:var(--clyra-accent,#0052fb)]/70" : "border-slate-300",
            )}
          />
          <div className="h-3.5 w-3.5 rounded-full border-2 border-white bg-[color:var(--clyra-accent,#0052fb)] shadow-[0_2px_8px_rgba(0,82,251,.35)]" />
          <div
            className={cn(
              "ml-2 mt-2 inline-block max-w-[220px] truncate rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_6px_18px_rgba(15,23,42,.12)]",
              demoMode === "guide" ? "bg-[color:var(--clyra-accent,#0052fb)]" : "bg-slate-800",
            )}
          >
            {pointer.label}
          </div>
        </div>
      ) : null}

      {demoMode === "ai" || demoMode === "user" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center">
          <div className="pointer-events-auto flex h-9 max-w-[min(420px,92%)] items-stretch overflow-hidden rounded-full border border-[color:var(--clyra-border,#e5e7eb)] bg-white text-[11.5px] font-medium text-[color:var(--clyra-text,#111827)] shadow-[0_10px_28px_rgba(15,23,42,0.12)]">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-3.5">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[color:var(--clyra-accent,#0052fb)]" />
              <span className="min-w-0 truncate">
                {demoMode === "user" ? "You have control" : "AI has control"}
              </span>
            </div>
            {demoMode === "user" ? (
              <button
                type="button"
                onClick={() => setDemoMode("ai")}
                className="shrink-0 border-l border-[color:var(--clyra-border,#e5e7eb)] px-3.5 text-[11px] font-semibold hover:bg-[color:var(--clyra-hover,#f3f4f6)]"
              >
                Resume AI
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setDemoMode("user")}
                className="shrink-0 border-l border-[color:var(--clyra-border,#e5e7eb)] px-3.5 text-[11px] font-semibold hover:bg-[color:var(--clyra-hover,#f3f4f6)]"
              >
                Take control
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setDemoMode("off");
                setPointer(null);
              }}
              className="shrink-0 bg-rose-500 px-3.5 text-[11px] font-semibold text-white hover:brightness-105"
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
