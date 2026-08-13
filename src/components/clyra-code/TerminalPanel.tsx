import { Component, useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { motion } from "motion/react";
import { LoaderCircle, PanelBottomClose, PanelBottomOpen, Pencil, Plus, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AGENT_EASE } from "./motion";

type TerminalBridge = {
  open: (projectId: string, tabId: string) => Promise<void>;
  write: (tabId: string, data: string) => void;
  resize: (tabId: string, cols: number, rows: number) => void;
  kill: (tabId: string) => void;
  onData: (cb: (tabId: string, data: string) => void) => () => void;
  onExit: (cb: (tabId: string, code: number) => void) => () => void;
};

type SessionTab = { id: string; label: string; failed?: boolean; busy?: boolean };

function shellLabel() {
  if (navigator.userAgent.includes("Windows")) return "PowerShell";
  if (navigator.userAgent.includes("Linux")) return "bash";
  return "zsh";
}

function electronBridge(): TerminalBridge | null {
  const bridge = window.clyraDesktop?.terminal;
  if (!bridge) return null;
  return {
    open: async (projectId, tabId) => { await bridge.open({ projectId, tabId }); },
    write: (tabId, data) => void bridge.write({ tabId, data }),
    resize: (tabId, cols, rows) => void bridge.resize({ tabId, cols, rows }),
    kill: (tabId) => void bridge.kill({ tabId }),
    onData: (cb) => bridge.onData((payload) => {
      if (typeof payload === "string") cb("default", payload);
      else if (payload.data) cb(payload.tabId || "default", payload.data);
    }),
    onExit: (cb) => bridge.onExit((payload) => {
      if (typeof payload === "number") cb("default", payload);
      else cb(payload.tabId || "default", payload.code ?? 0);
    }),
  };
}

function websocketBridge(): TerminalBridge {
  const sockets = new Map<string, WebSocket>();
  const dataCbs = new Set<(tabId: string, data: string) => void>();
  const exitCbs = new Set<(tabId: string, code: number) => void>();
  return {
    open: async (projectId, tabId) => {
      const existing = sockets.get(tabId);
      if (existing?.readyState === WebSocket.OPEN) return;
      if (existing?.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve, reject) => {
          existing.addEventListener("open", () => resolve(), { once: true });
          existing.addEventListener("error", () => reject(new Error("Terminal connection failed.")), { once: true });
        });
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/api/terminal?projectId=${encodeURIComponent(projectId)}&tabId=${encodeURIComponent(tabId)}`);
      sockets.set(tabId, socket);
      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as { type?: string; tabId?: string; data?: string; code?: number };
          if (payload.type === "data" && payload.data) for (const cb of dataCbs) cb(payload.tabId || tabId, payload.data);
          if (payload.type === "exit") for (const cb of exitCbs) cb(payload.tabId || tabId, payload.code ?? 0);
        } catch { /* ignore malformed frames */ }
      };
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Terminal connection failed.")), { once: true });
      });
    },
    write: (tabId, data) => {
      const socket = sockets.get(tabId);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    },
    resize: (tabId, cols, rows) => {
      const socket = sockets.get(tabId);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    kill: (tabId) => { sockets.get(tabId)?.close(); sockets.delete(tabId); },
    onData: (cb) => { dataCbs.add(cb); return () => dataCbs.delete(cb); },
    onExit: (cb) => { exitCbs.add(cb); return () => exitCbs.delete(cb); },
  };
}

const TERM_THEME = { background: "#FFFFFF", foreground: "#282B2F", cursor: "#3977F6", cursorAccent: "#FFFFFF", selectionBackground: "rgba(57,119,246,0.16)", black: "#3F4347", red: "#C24949", green: "#268A50", yellow: "#B87918", blue: "#3977F6", magenta: "#9A5CC9", cyan: "#1F8A9A", white: "#B7B9BD", brightBlack: "#96989D", brightRed: "#E07B7B", brightGreen: "#4FAE74", brightYellow: "#D9A04C", brightBlue: "#7CA6F8", brightMagenta: "#BC8FDF", brightCyan: "#57B6C4", brightWhite: "#FFFFFF" };

class TerminalErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="h-8 border-t border-black/[0.06] bg-white px-3 py-2 text-[11px] text-[#B94B4B]">Terminal unavailable in this view</div> : this.props.children; }
}

function TerminalPanelInner({ projectId, open, height, onHeightChange, onToggle, agentActivityCount: _agentActivityCount = 0 }: { projectId: string | null; open: boolean; height: number; onHeightChange: (height: number) => void; onToggle: () => void; agentActivityCount?: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const bridgeRef = useRef<TerminalBridge | null>(null);
  const activeRef = useRef("terminal-1");
  const outputRef = useRef(new Map<string, string>());
  const sequenceRef = useRef(1);
  const startupTimersRef = useRef(new Map<string, number>());
  const [hostReady, setHostReady] = useState(false);
  const [tabs, setTabs] = useState<SessionTab[]>([{ id: "terminal-1", label: shellLabel() }]);
  const [activeTab, setActiveTab] = useState("terminal-1");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [tabLabel, setTabLabel] = useState("");
  const tabInputRef = useRef<HTMLInputElement | null>(null);

  const fit = useCallback((tabId = activeRef.current) => {
    const node = mountRef.current;
    const term = termRef.current;
    if (!node || !term) return;
    const cols = Math.max(40, Math.floor(node.clientWidth / 7.24));
    const rows = Math.max(4, Math.floor(node.clientHeight / 16.8));
    term.resize(cols, rows);
    bridgeRef.current?.resize(tabId, cols, rows);
  }, []);

  const connect = useCallback((tabId: string) => {
    if (!termRef.current) return;
    const bridge = bridgeRef.current ?? (bridgeRef.current = electronBridge() ?? websocketBridge());
    const hasLiveOutput = Boolean(outputRef.current.get(tabId));
    // A collapsed/reselected tab already has a real shell and scrollback.
    // Don't turn it back into a "starting" session or arm a stale timeout.
    if (hasLiveOutput) {
      setTabs((items) => items.map((item) => item.id === tabId ? { ...item, failed: false, busy: false } : item));
      fit(tabId);
      return;
    }
    setTabs((items) => items.map((item) => item.id === tabId ? { ...item, failed: false, busy: true } : item));
    // A fresh workspace has no project yet.  Still give the user a working
    // shell immediately, rooted in Clyra's projects directory, rather than
    // leaving a permanently blank terminal until their first prompt.
    void bridge.open(projectId ?? "", tabId).then(() => {
      // Socket connection is enough to make the panel usable. The first PTY
      // output clears the tiny starting marker; it is not a prerequisite for
      // rendering or focusing xterm.
      fit(tabId);
    }).catch(() => setTabs((items) => items.map((item) => item.id === tabId ? { ...item, failed: true, busy: false } : item)));
    const existingTimer = startupTimersRef.current.get(tabId);
    if (existingTimer) window.clearTimeout(existingTimer);
    startupTimersRef.current.set(tabId, window.setTimeout(() => {
      setTabs((items) => items.map((item) => item.id === tabId && item.busy ? { ...item, failed: true, busy: false } : item));
    }, 2000));
  }, [fit, projectId]);

  useEffect(() => {
    if (!hostReady) return;
    if (!termRef.current && mountRef.current) {
      const term = new Terminal({ convertEol: false, cursorBlink: true, cursorStyle: "bar", fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.4, theme: TERM_THEME, allowProposedApi: true });
      term.open(mountRef.current);
      term.onData((data) => bridgeRef.current?.write(activeRef.current, data));
      termRef.current = term;
    }
    const bridge = bridgeRef.current ?? (bridgeRef.current = electronBridge() ?? websocketBridge());
    const offData = bridge.onData((tabId, data) => {
      const timer = startupTimersRef.current.get(tabId);
      if (timer) {
        window.clearTimeout(timer);
        startupTimersRef.current.delete(tabId);
      }
      setTabs((items) => items.map((item) => item.id === tabId ? { ...item, busy: false, failed: false } : item));
      outputRef.current.set(tabId, (outputRef.current.get(tabId) || "") + data);
      if (tabId === activeRef.current) {
        termRef.current?.write(data, () => termRef.current?.scrollToBottom());
      }
    });
    const offExit = bridge.onExit((tabId) => {
      const timer = startupTimersRef.current.get(tabId);
      if (timer) {
        window.clearTimeout(timer);
        startupTimersRef.current.delete(tabId);
      }
      setTabs((items) => items.map((item) => item.id === tabId ? { ...item, busy: false, failed: true } : item));
    });
    connect(activeRef.current);
    return () => {
      offData();
      offExit();
      for (const timer of startupTimersRef.current.values()) window.clearTimeout(timer);
      startupTimersRef.current.clear();
    };
  }, [connect, hostReady, projectId]);

  useEffect(() => {
    activeRef.current = activeTab;
    const term = termRef.current;
    if (!term) return;
    term.reset();
    const saved = outputRef.current.get(activeTab);
    if (saved) term.write(saved);
    connect(activeTab);
    requestAnimationFrame(() => { fit(activeTab); term.scrollToBottom(); term.focus(); });
  }, [activeTab, connect, fit, projectId]);

  useEffect(() => {
    const node = mountRef.current;
    if (!node || !open) return;
    const observer = new ResizeObserver(() => { fit(); termRef.current?.scrollToBottom(); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fit, height, open]);

  useEffect(() => {
    if (editingTab) requestAnimationFrame(() => { tabInputRef.current?.focus(); tabInputRef.current?.select(); });
  }, [editingTab]);

  const addTab = () => {
    const id = `terminal-${++sequenceRef.current}`;
    outputRef.current.set(id, "");
    setTabs((items) => [...items, { id, label: shellLabel() }]);
    setActiveTab(id);
  };
  const closeTab = (tabId: string) => {
    if (tabs.length === 1) return;
    bridgeRef.current?.kill(tabId);
    outputRef.current.delete(tabId);
    setTabs((items) => {
      const index = items.findIndex((item) => item.id === tabId);
      const next = items.filter((item) => item.id !== tabId);
      if (tabId === activeRef.current) setActiveTab(next[Math.max(0, index - 1)]?.id || next[0].id);
      return next;
    });
  };
  const restart = (tabId = activeTab) => {
    bridgeRef.current?.kill(tabId);
    outputRef.current.set(tabId, "");
    termRef.current?.reset();
    setTabs((items) => items.map((item) => item.id === tabId ? { ...item, failed: false } : item));
    window.setTimeout(() => connect(tabId), 24);
  };
  const renameTab = (tabId: string) => {
    const label = tabLabel.trim();
    if (label) setTabs((items) => items.map((item) => item.id === tabId ? { ...item, label } : item));
    setEditingTab(null);
  };
  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY; const startHeight = height;
    const move = (moveEvent: PointerEvent) => onHeightChange(Math.min(520, Math.max(120, startHeight + startY - moveEvent.clientY)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const active = tabs.find((item) => item.id === activeTab);
  const activeFailed = active?.failed;
  return <div className="shrink-0 border-t border-black/[0.07] bg-white">
    <div className="flex h-8 items-center gap-1 border-b border-black/[0.055] px-2.5" role="tablist" aria-label="Terminal sessions">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={tab.id === activeTab} onClick={() => { setActiveTab(tab.id); if (!open) onToggle(); }} className={`group relative flex h-7 min-w-[120px] max-w-[220px] items-center gap-1.5 rounded-[7px] px-2.5 text-left text-[11.5px] transition-colors duration-150 ${tab.id === activeTab ? "bg-black/[0.055] text-[#292B30]" : "text-[#85878C] hover:bg-black/[0.03] hover:text-[#4D4F54]"}`}>
          {tab.busy ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={1.7} /> : <TerminalSquare className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />}
          {editingTab === tab.id ? <input ref={tabInputRef} value={tabLabel} aria-label="Rename terminal" onClick={(event) => event.stopPropagation()} onChange={(event) => setTabLabel(event.target.value)} onBlur={() => renameTab(tab.id)} onKeyDown={(event) => { if (event.key === "Enter") renameTab(tab.id); if (event.key === "Escape") setEditingTab(null); }} className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none" /> : <span className="min-w-0 flex-1 truncate">{tab.label}</span>}{tab.failed ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#C24949]" /> : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
            <span role="button" aria-label={`Rename ${tab.label}`} onClick={(event) => { event.stopPropagation(); setTabLabel(tab.label); setEditingTab(tab.id); }} className="flex h-4 w-4 items-center justify-center rounded text-[#92949A] hover:bg-black/[0.07]"><Pencil className="h-2.5 w-2.5" /></span>
            {tabs.length > 1 ? <span role="button" aria-label={`Close ${tab.label}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} className="flex h-4 w-4 items-center justify-center rounded text-[#92949A] hover:bg-black/[0.07]"><X className="h-3 w-3" /></span> : null}
          </span>
        </button>)}
        <button type="button" aria-label="New terminal tab" title="New terminal tab" onClick={addTab} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[#77797E] transition-colors hover:bg-black/[0.045] hover:text-[#222428]"><Plus className="h-4 w-4" strokeWidth={1.7} /></button>
      </div>
      <button type="button" aria-label={open ? "Collapse terminal" : "Expand terminal"} title={open ? "Collapse terminal" : "Open terminal"} onClick={onToggle} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045]">{open ? <PanelBottomClose className="h-[16px] w-[16px]" strokeWidth={1.6} /> : <PanelBottomOpen className="h-[16px] w-[16px]" strokeWidth={1.6} />}</button>
    </div>
    <motion.div initial={false} animate={{ height: open ? height : 0, opacity: open ? 1 : 0 }} transition={{ height: { duration: 0.27, ease: AGENT_EASE }, opacity: { duration: 0.16 } }} className="relative overflow-hidden">
      <div className="absolute left-0 right-0 top-0 z-10 h-1.5 cursor-row-resize" onPointerDown={onDragStart} aria-hidden />
      {active?.busy ? <div className="pointer-events-none absolute right-2 top-1 z-10 text-[10.5px] text-[#96989D]">Starting shell…</div> : null}
      {activeFailed ? <div className="absolute right-2 top-1 z-10 flex items-center gap-1.5 text-[10.5px] text-[#B94B4B]"><span>Shell failed to start</span><button type="button" onClick={() => restart()} className="rounded px-1 py-0.5 text-[#55575C] hover:bg-black/[0.04]">Restart</button></div> : null}
      <div ref={(node) => { mountRef.current = node; if (node) setHostReady(true); }} className="h-full w-full bg-white px-2 pb-1.5 pt-1" />
    </motion.div>
  </div>;
}

export function TerminalPanel(props: ComponentProps<typeof TerminalPanelInner>) { return <TerminalErrorBoundary><TerminalPanelInner {...props} /></TerminalErrorBoundary>; }
