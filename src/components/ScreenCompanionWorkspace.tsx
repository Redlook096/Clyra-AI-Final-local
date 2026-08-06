/**
 * Web preview of Screen Companion (Electron owns real capture + desktop control).
 * OpenCluely-inspired: talk about what you're doing; AI can see screen evidence.
 */
import { useCallback, useState } from "react";
import { Eye, MonitorSmartphone, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "./ShiningText";
import { getElectronDesktop } from "../lib/electron-runtime";

type Message = { id: string; role: "user" | "assistant"; text: string; vision?: string };

function speakReply(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text.replace(/[`*_#]/g, " ").slice(0, 600));
  utter.rate = 0.94;
  utter.pitch = 1.03;
  utter.volume = 0.96;
  window.speechSynthesis.speak(utter);
}

export default function ScreenCompanionWorkspace() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "I'm Clyra Companion. Talk to me while you work — in Electron I can see your screen and take control with the same cursor UI as AI Browser.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [demoControl, setDemoControl] = useState<"off" | "ai" | "user">("off");
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
      speakReply(text);
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
  }, [busy, input]);

  return (
    <div className="relative flex h-full min-h-0 bg-[#f4f5f8] text-[#1a1d26]" style={{ fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif" }}>
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-black/[0.07] bg-[#eef0f5] px-4 py-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#2b6ef2] text-[11px] font-bold text-white">C</div>
        <h1 className="mt-4 text-[15px] font-semibold tracking-[-0.02em]">Screen Companion</h1>
        <p className="mt-1 text-[12px] leading-5 text-[#8b919c]">
          OpenCluely-style helper for everyday work — talk, see your screen, optionally take control.
        </p>
        <button
          type="button"
          onClick={() => void desktop?.companion?.toggle?.()}
          className="mt-5 flex h-9 items-center justify-center gap-2 rounded-[9px] border border-black/10 bg-white text-[12.5px] font-medium transition-colors hover:bg-white/90"
        >
          <MonitorSmartphone className="h-4 w-4" />
          {desktop ? "Open Electron overlay (⌘⇧J)" : "Electron required for overlay"}
        </button>
        <button
          type="button"
          onClick={() => setDemoControl((c) => (c === "off" ? "ai" : "off"))}
          className="mt-2 flex h-9 items-center justify-center gap-2 rounded-[9px] bg-[#171817] text-[12.5px] font-medium text-white"
        >
          {demoControl === "off" ? "Preview Take control bar" : "Hide control bar"}
        </button>
        <ul className="mt-6 space-y-2 text-[12px] text-[#5c6370]">
          <li className="flex gap-2"><Sparkles className="mt-0.5 h-3.5 w-3.5 text-[#2b6ef2]" /> Uses Clyra chat / STT / TTS</li>
          <li className="flex gap-2"><Eye className="mt-0.5 h-3.5 w-3.5 text-[#2b6ef2]" /> RapidOCR ONNX vision (8GB-safe)</li>
          <li className="flex gap-2"><MonitorSmartphone className="mt-0.5 h-3.5 w-3.5 text-[#2b6ef2]" /> Atlas Take control / Stop cursor UI</li>
        </ul>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {messages.map((message) => (
            <div key={message.id} className={cn("flex", message.role === "user" && "justify-end")}>
              <div
                className={cn(
                  "max-w-[720px] text-[14px] leading-[1.55] tracking-[-0.01em]",
                  message.role === "user"
                    ? "rounded-[14px] bg-[#eef0f4] px-3.5 py-2.5"
                    : "text-[#1a1d26]",
                )}
              >
                {message.text}
              </div>
            </div>
          ))}
          {busy ? (
            <div className="flex items-center gap-2 py-1">
              <ShiningBrainIcon className="h-4 w-4" />
              <ShiningText text="Thinking" play className="text-[14px] font-medium" />
              <ThinkingDots />
            </div>
          ) : null}
        </div>
        <div className="border-t border-black/[0.07] px-6 py-3">
          <div className="mx-auto flex max-w-[720px] items-end gap-2 rounded-[16px] border border-black/[0.08] bg-white px-3 py-2">
            <textarea
              value={input}
              rows={2}
              placeholder="Ask about what I'm doing…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void ask();
                }
              }}
              className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] outline-none"
            />
            <button
              type="button"
              disabled={!input.trim() || busy}
              onClick={() => void ask()}
              className="mb-0.5 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#2b6ef2] text-white disabled:bg-[#e8eaef] disabled:text-[#b0b5bf]"
            >
              ↑
            </button>
          </div>
        </div>
      </main>

      {demoControl !== "off" ? (
        <div className="pointer-events-auto absolute bottom-5 left-1/2 z-20 flex h-[30px] max-w-[min(420px,92%)] -translate-x-1/2 items-stretch overflow-hidden rounded-[8px] bg-[#171817] text-[11px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,.28)]">
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-white/80" />
            <span className="min-w-0 truncate text-white/90">
              {demoControl === "user" ? "You have control" : "Helping with your screen"}
            </span>
          </div>
          {demoControl === "user" ? (
            <button
              type="button"
              onClick={() => setDemoControl("ai")}
              className="shrink-0 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 hover:bg-white/10"
            >
              Resume AI
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setDemoControl("user")}
              className="shrink-0 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 hover:bg-white/10"
            >
              Take control
            </button>
          )}
          <button
            type="button"
            onClick={() => setDemoControl("off")}
            className="shrink-0 bg-[#dd5e58] px-3 text-[10.5px] font-semibold text-white hover:brightness-110"
          >
            Stop
          </button>
        </div>
      ) : null}
    </div>
  );
}
