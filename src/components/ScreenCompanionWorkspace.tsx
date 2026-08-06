/**
 * Web preview of Screen Companion (Electron owns real capture + desktop control).
 * Matches chat tool light theme: #fbfbfa, #0052fb, soft user bubbles.
 */
import { useCallback, useState } from "react";
import { Eye, MessageSquareText, MonitorSmartphone, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "./ShiningText";
import { getElectronDesktop } from "../lib/electron-runtime";
import { VoiceWaveform } from "./voice/VoiceWaveform";

type Message = { id: string; role: "user" | "assistant"; text: string; vision?: string };

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
      role: "assistant",
      text: "I'm Clyra Companion. Talk or message while you work — share your screen from a voice call, or open the Electron overlay so I can see your desktop.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"talk" | "message">("talk");
  const [demoControl, setDemoControl] = useState<"off" | "ai" | "user">("off");
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
      className="relative flex h-full min-h-0 bg-[#fbfbfa] text-[#18212f]"
      style={{ fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif" }}
    >
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[#e7e7e4] bg-white px-4 py-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0052fb] text-[11px] font-bold text-white">C</div>
        <h1 className="mt-4 text-[15px] font-semibold tracking-[-0.02em]">Screen Companion</h1>
        <p className="mt-1 text-[12px] leading-5 text-[#8b939e]">
          OpenCluely-style helper — talk, message, see your screen, optionally take control.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("talk")}
            className={cn(
              "h-8 flex-1 rounded-full border text-[12px] font-medium",
              mode === "talk" ? "border-[#0052fb] bg-[#eef4ff] text-[#0052fb]" : "border-[#e7e7e4] bg-white text-[#697386]",
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
              "h-8 flex-1 rounded-full border text-[12px] font-medium",
              mode === "message" ? "border-[#0052fb] bg-[#eef4ff] text-[#0052fb]" : "border-[#e7e7e4] bg-white text-[#697386]",
            )}
          >
            Message
          </button>
        </div>
        <button
          type="button"
          onClick={() => void desktop?.companion?.toggle?.()}
          className="mt-3 flex h-9 items-center justify-center gap-2 rounded-[12px] border border-[#e7e7e4] bg-white text-[12.5px] font-medium transition-colors hover:bg-[#f7f8fa]"
        >
          <MonitorSmartphone className="h-4 w-4" />
          {desktop ? "Open Electron overlay (⌘⇧J)" : "Electron required for overlay"}
        </button>
        <button
          type="button"
          onClick={() => setDemoControl((c) => (c === "off" ? "ai" : "off"))}
          className="mt-2 flex h-9 items-center justify-center gap-2 rounded-[12px] bg-[#171817] text-[12.5px] font-medium text-white"
        >
          {demoControl === "off" ? "Preview Take control bar" : "Hide control bar"}
        </button>
        <ul className="mt-6 space-y-2 text-[12px] text-[#697386]">
          <li className="flex gap-2"><Sparkles className="mt-0.5 h-3.5 w-3.5 text-[#0052fb]" /> Clyra chat / STT / TTS</li>
          <li className="flex gap-2"><Eye className="mt-0.5 h-3.5 w-3.5 text-[#0052fb]" /> RapidOCR ONNX vision (8GB-safe)</li>
          <li className="flex gap-2"><MessageSquareText className="mt-0.5 h-3.5 w-3.5 text-[#0052fb]" /> Message mode + voice call screenshare</li>
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
                    ? "rounded-[14px] bg-[#aec7f1] px-3.5 py-2.5 text-[#18212f]"
                    : "text-[#18212f]",
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
        <div className="border-t border-[#e7e7e4] px-6 py-3">
          {listeningDemo ? (
            <div className="mx-auto mb-2 max-w-[720px]">
              <VoiceWaveform level={0.35} active compact />
            </div>
          ) : null}
          <div className="mx-auto flex max-w-[720px] items-end gap-2 rounded-[18px] border border-[#dfe7f1] bg-white px-3 py-2">
            <button
              type="button"
              onClick={() => setListeningDemo((v) => !v)}
              className={cn(
                "mb-0.5 flex h-[30px] items-center rounded-full px-2.5 text-[11px] font-medium",
                listeningDemo ? "bg-[#eef4ff] text-[#0052fb]" : "text-[#697386] hover:bg-[#f1f3f7]",
              )}
            >
              Mic
            </button>
            <textarea
              value={input}
              rows={2}
              placeholder={mode === "message" ? "Message about your screen…" : "Ask about what I'm doing…"}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void ask();
                }
              }}
              className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] outline-none placeholder:text-[#8b939e]"
            />
            <button
              type="button"
              disabled={!input.trim() || busy}
              onClick={() => void ask()}
              className="mb-0.5 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#0052fb] text-white disabled:bg-[#e8eaef] disabled:text-[#b0b5bf]"
            >
              ↑
            </button>
          </div>
        </div>
      </main>

      {demoControl !== "off" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-5">
          <div className="pointer-events-auto flex h-[30px] max-w-[min(420px,92%)] items-stretch overflow-hidden rounded-[8px] bg-[#171817] text-[11px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,.28)]">
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
        </div>
      ) : null}
    </div>
  );
}
