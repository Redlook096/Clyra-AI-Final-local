import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Runs `xcodes install <version>` in a real interactive shell (the same
 * per-project PTY the Terminal tab uses — lib/terminal-ws.ts) and shows its
 * live output right inside the setup wizard, so "Install" in Clyra actually
 * runs the command instead of telling the user to paste it elsewhere.
 *
 * The security boundary stays real: when Apple's installer prompts for an
 * Apple ID / password / MFA code, that text appears here as plain terminal
 * output and the user types their answer directly into this same PTY — it
 * goes straight to the shell process, never through this component's state,
 * never logged, never seen by any model.
 */
export function IPhoneInstallTerminal({ projectId, command: installCommand, onDone }: { projectId: string; command: string; onDone?: () => void }) {
  const [lines, setLines] = useState("");
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const sentCommandRef = useRef(false);
  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/terminal?projectId=${encodeURIComponent(projectId)}&tabId=xcode-install&replay=0`);
    wsRef.current = socket;
    socket.onopen = () => {
      setConnected(true);
      if (!sentCommandRef.current) {
        sentCommandRef.current = true;
        socket.send(JSON.stringify({ type: "input", data: `${installCommand}\n` }));
      }
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "data") {
          setLines((prev) => (prev + message.data).slice(-20_000));
        } else if (message.type === "exit") {
          setLines((prev) => prev + `\n[process exited with code ${message.code}]\n`);
          onDone?.();
        }
      } catch { /* ignore malformed frame */ }
    };
    socket.onclose = () => setConnected(false);
    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, installCommand]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [lines]);

  const send = useCallback(() => {
    if (!input) return;
    wsRef.current?.send(JSON.stringify({ type: "input", data: input + "\n" }));
    setInput("");
  }, [input]);

  return (
    <div className="flex w-full max-w-[420px] flex-col gap-1.5">
      <p className="text-[10.5px] font-medium text-[#84868B]">
        {connected ? "Running in a real shell — if Apple asks you to sign in, type your answer below:" : "Connecting…"}
      </p>
      <div ref={outputRef} className="h-[160px] overflow-y-auto whitespace-pre-wrap rounded-[8px] bg-[#1C1C1E] p-2.5 font-mono text-[10.5px] leading-[1.5] text-[#D6D6D5]">
        {lines || " "}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") send(); }}
          placeholder="Type here if the terminal is waiting for input…"
          className="h-7 flex-1 rounded-[6px] border border-black/[0.08] px-2 text-[11px] outline-none focus:border-[#3977F6]"
        />
        <button type="button" onClick={send} className="h-7 rounded-[6px] bg-[#3977F6] px-2.5 text-[11px] font-medium text-white hover:bg-[#2E68E0]">Send</button>
      </div>
    </div>
  );
}
