/**
 * Screen Companion web preview — OpenCluely glass UI language,
 * wired to Clyra RapidOCR + optional Electron overlay / guide pointer / control.
 */
import { useCallback, useState } from "react";
import { Eye, MousePointer2, MonitorSmartphone, Sparkles } from "lucide-react";
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
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "system",
      text: "OpenCluely-style overlay · Clyra RapidOCR vision. Guide points without clicking; Control drives the OS cursor. No stealth.",
    },
    {
      id: "hello",
      role: "assistant",
      text: "Ask what you’re looking at, or say “show me where to click” and I’ll point with a visible cursor.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"talk" | "message">("talk");
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
      const screenCtx =
        typeof window !== "undefined" && (window as Window & { __companionScreenContext?: { visionSummary?: string; ocrText?: string } }).__companionScreenContext;
      const response = await fetch("/api/companion/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          visionSummary:
            screenCtx?.visionSummary ||
            "User is asking about their current screen via Clyra Companion (OpenCluely UI, no stealth).",
          ocrText: screenCtx?.ocrText || "",
        }),
      });
      const payload = await response.json();
      const text = String(
        payload.text || payload?.choices?.[0]?.message?.content || payload.error || "No reply",
      );
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text }]);
      if (/\b(where|point|show me|click|press|tap|guide)\b/i.test(question)) {
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
      className="relative flex h-full min-h-0 overflow-hidden"
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        background:
          "radial-gradient(1200px 600px at 20% 0%, rgba(59,130,246,0.14), transparent 55%), radial-gradient(900px 500px at 90% 20%, rgba(16,185,129,0.1), transparent 50%), #0b0c10",
      }}
    >
      {/* OpenCluely-style floating command tab */}
      <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center">
        <div className="pointer-events-auto flex h-[34px] items-center gap-1 rounded-[10px] border border-white/15 bg-black/45 px-2 text-[11px] font-semibold text-white/90 shadow-[0_8px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <button
            type="button"
            className="rounded-[7px] px-2.5 py-1 hover:bg-white/10"
            onClick={() => {
              setMessages((prev) => [
                ...prev,
                { id: `s-${Date.now()}`, role: "system", text: "See screen uses RapidOCR in Electron. Web preview shows the same UI." },
              ]);
            }}
          >
            📷 <span className="text-white/55">See</span>
          </button>
          <span className="h-3.5 w-px bg-gradient-to-b from-transparent via-white/30 to-transparent" />
          <button
            type="button"
            className={cn("rounded-[7px] px-2.5 py-1 hover:bg-white/10", listeningDemo && "text-[#ff4757]")}
            onClick={() => setListeningDemo((v) => !v)}
          >
            🎙
          </button>
          <span className="h-3.5 w-px bg-gradient-to-b from-transparent via-white/30 to-transparent" />
          <button
            type="button"
            className={cn(
              "rounded-[7px] px-2.5 py-1 hover:bg-white/10",
              demoMode === "guide" && "bg-emerald-500/15 text-emerald-300",
            )}
            onClick={() => {
              setDemoMode("guide");
              setPointer({ x: 62, y: 48, label: "Click Apply filters" });
              setMessages((prev) => [
                ...prev,
                {
                  id: `g-${Date.now()}`,
                  role: "assistant",
                  text: "Guide mode — I'm pointing at where to click. The blue ring is visual only; I have not taken control.",
                },
              ]);
            }}
          >
            ◎ <span className="text-white/55">Guide</span>
          </button>
          <span className="h-3.5 w-px bg-gradient-to-b from-transparent via-white/30 to-transparent" />
          <button
            type="button"
            className={cn(
              "rounded-[7px] px-2.5 py-1 hover:bg-white/10",
              (demoMode === "ai" || demoMode === "user") && "bg-emerald-500/15 text-emerald-300",
            )}
            onClick={() => {
              setDemoMode("ai");
              setPointer({ x: 40, y: 55, label: "Working" });
            }}
          >
            ◉ <span className="text-white/55">Control</span>
          </button>
          <span className="ml-1 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.55)]" />
        </div>
      </div>

      <aside className="relative z-10 m-4 mt-16 flex w-[280px] shrink-0 flex-col rounded-[12px] border border-white/10 bg-black/45 p-4 text-white shadow-[0_10px_36px_rgba(0,0,0,0.28)] backdrop-blur-2xl">
        <div className="text-[13px] font-semibold tracking-[-0.01em]">Clyra Companion</div>
        <p className="mt-1 text-[11.5px] leading-5 text-white/55">
          OpenCluely UI · RapidOCR ONNX · Guide pointer · optional desktop control
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setMode("talk");
              setListeningDemo(true);
            }}
            className={cn(
              "h-8 flex-1 rounded-[7px] border text-[12px] font-semibold",
              mode === "talk"
                ? "border-sky-300/40 bg-sky-500/20 text-sky-100"
                : "border-white/15 bg-white/5 text-white/70",
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
              "h-8 flex-1 rounded-[7px] border text-[12px] font-semibold",
              mode === "message"
                ? "border-sky-300/40 bg-sky-500/20 text-sky-100"
                : "border-white/15 bg-white/5 text-white/70",
            )}
          >
            Message
          </button>
        </div>
        <button
          type="button"
          onClick={() => void desktop?.companion?.toggle?.()}
          className="mt-3 flex h-9 items-center justify-center gap-2 rounded-[8px] border border-white/15 bg-white/10 text-[12.5px] font-semibold text-white/90 hover:bg-white/15"
        >
          <MonitorSmartphone className="h-4 w-4" />
          {desktop ? "Open Electron overlay (⌘⇧J)" : "Electron required for overlay"}
        </button>
        <ul className="mt-6 space-y-2.5 text-[12px] text-white/65">
          <li className="flex gap-2"><Sparkles className="mt-0.5 h-3.5 w-3.5 text-sky-300" /> Clyra chat / STT / TTS</li>
          <li className="flex gap-2"><Eye className="mt-0.5 h-3.5 w-3.5 text-sky-300" /> RapidOCR open-source vision</li>
          <li className="flex gap-2"><MousePointer2 className="mt-0.5 h-3.5 w-3.5 text-sky-300" /> Guide points · Control clicks</li>
        </ul>
      </aside>

      <main className="relative z-10 m-4 mt-16 mr-4 flex min-w-0 flex-1 flex-col rounded-[12px] border border-white/10 bg-black/50 text-white shadow-[0_10px_36px_rgba(0,0,0,0.28)] backdrop-blur-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="text-[13px] font-semibold">Chat</span>
          <span className="text-[10.5px] text-white/45">RapidOCR · no stealth</span>
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "rounded-[8px] border-l-[3px] px-3 py-2.5 text-[13px] leading-[1.5]",
                message.role === "user" && "border-amber-400/70 bg-amber-500/10",
                message.role === "assistant" && "border-sky-300/70 bg-sky-500/10",
                message.role === "system" && "border-sky-400/50 bg-sky-500/10 text-white/75 text-[12px]",
              )}
            >
              {message.text}
            </div>
          ))}
          {busy ? (
            <div className="flex items-center gap-2 text-[12px] text-white/55">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
              Thinking
            </div>
          ) : null}
        </div>
        <div className="border-t border-white/10 bg-black/25 px-4 py-3">
          {listeningDemo ? (
            <div className="mb-2">
              <VoiceWaveform level={0.35} active compact />
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              rows={2}
              placeholder={mode === "message" ? "Message about your screen…" : "Ask about your screen, or how to click something…"}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void ask();
                }
              }}
              className="min-h-[44px] flex-1 resize-none bg-transparent text-[13.5px] text-white outline-none placeholder:text-white/35"
            />
            <button
              type="button"
              disabled={!input.trim() || busy}
              onClick={() => void ask()}
              className="mb-0.5 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-sky-500 text-white disabled:bg-white/10 disabled:text-white/30"
            >
              ↑
            </button>
          </div>
          <p className="mt-2 text-[10px] text-white/40">⌘⇧J · Guide points without clicking · Control drives the OS cursor</p>
        </div>
      </main>

      {/* Guide / control cursor preview */}
      {pointer && demoMode !== "off" ? (
        <div
          className="companion-agent-cursor pointer-events-none absolute z-40"
          style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }}
          data-testid="companion-guide-cursor"
        >
          <span className="companion-agent-cursor__halo" aria-hidden />
          <svg className="companion-agent-cursor__arrow" viewBox="0 0 28 32" aria-hidden>
            <path d="M4.62 2.72C3.09 1.91 1.57 3.43 2.39 4.96l8.36 16.3c.75 1.47 2.87 1.39 3.5-.13l2.69-6.51 6.51-2.69c1.52-.63 1.6-2.75.13-3.5L4.62 2.72Z" />
          </svg>
          {demoMode === "guide" ? <span className="companion-agent-cursor__click" aria-hidden /> : null}
          <div
            className={cn(
              "companion-agent-cursor__label inline-block max-w-[220px] truncate rounded-[7px] px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_6px_18px_rgba(0,0,0,.28)]",
              demoMode === "guide" ? "bg-[#1d4ed8]" : "bg-[#171817]",
            )}
          >
            {pointer.label}
          </div>
        </div>
      ) : null}

      {demoMode === "ai" || demoMode === "user" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center">
          <div className="pointer-events-auto flex h-[30px] max-w-[min(420px,92%)] items-stretch overflow-hidden rounded-[8px] bg-[#171817] text-[11px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,.28)]">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-white/80" />
              <span className="min-w-0 truncate text-white/90">
                {demoMode === "user" ? "You have control" : "AI has control"}
              </span>
            </div>
            {demoMode === "user" ? (
              <button
                type="button"
                onClick={() => setDemoMode("ai")}
                className="shrink-0 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 hover:bg-white/10"
              >
                Resume AI
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setDemoMode("user")}
                className="shrink-0 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 hover:bg-white/10"
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
              className="shrink-0 bg-[#dd5e58] px-3 text-[10.5px] font-semibold text-white hover:brightness-110"
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
