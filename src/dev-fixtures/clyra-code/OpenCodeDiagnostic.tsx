import { useCallback, useEffect, useState } from "react";

type Log = { time: string; label: string; value: unknown };

/** Development-only SDK verification surface. It uses the same local routes as
 * production Clyra Code, never fixture events. */
export default function OpenCodeDiagnostic() {
  const [projectId, setProjectId] = useState("opencode-smoke-project");
  const [sessionId, setSessionId] = useState("");
  const [state, setState] = useState<Record<string, unknown>>({});
  const [logs, setLogs] = useState<Log[]>([]);
  const log = useCallback((label: string, value: unknown) => setLogs((current) => [{ time: new Date().toLocaleTimeString(), label, value }, ...current].slice(0, 200)), []);
  const request = useCallback(async (label: string, url: string, init?: RequestInit) => {
    const response = await fetch(url, init); const body = await response.json(); log(label, body); setState(body); if (!response.ok) throw new Error(String(body.error || label)); return body;
  }, [log]);
  useEffect(() => { void request("Health check", "/api/opencode/status").catch(() => undefined); }, [request]);
  useEffect(() => {
    const source = new EventSource(`/api/opencode/events/${encodeURIComponent(projectId)}`);
    source.onmessage = (event) => log("Event", JSON.parse(event.data));
    return () => source.close();
  }, [log, projectId]);
  const start = async () => request("Runtime started", "/api/opencode/runtime/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
  const create = async () => { const session = await request("Session created", "/api/opencode/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, title: "SDK diagnostic" }) }); setSessionId(String(session.id || "")); };
  const prompt = async () => request("Prompt submitted", `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Read package.json and tell me the project name. Do not modify any files." }) });
  const controls: Array<[string, () => Promise<unknown>]> = [
    ["Start runtime", start], ["Stop runtime", () => request("Runtime stopped", "/api/opencode/runtime/stop", { method: "POST" })], ["Health check", () => request("Health check", "/api/opencode/status")], ["Inspect project", () => request("Project inspection", `/api/opencode/diagnostic/${encodeURIComponent(projectId)}`)], ["Create session", create], ["List sessions", () => request("Sessions", `/api/opencode/sessions/${encodeURIComponent(projectId)}`)], ["Send test prompt", prompt], ["Fetch messages", () => request("Messages", `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/messages`)], ["Fetch diff", () => request("Diff", `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/diff`)], ["Abort", () => request("Abort", `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/abort`, { method: "POST" })],
  ];
  return <main className="min-h-screen bg-[#f6f6f4] p-6 font-sans text-[#242422]"><h1 className="text-lg font-semibold">OpenCode SDK diagnostic</h1><p className="mt-1 text-sm text-[#686864]">Runtime, session and real event-stream verification.</p><label className="mt-5 block text-xs font-medium">Project ID<input value={projectId} onChange={(e) => setProjectId(e.target.value)} className="ml-2 rounded border border-[#ddddda] bg-white px-2 py-1" /></label><p className="mt-2 text-xs text-[#686864]">Active session: {sessionId || "none"}</p><div className="mt-4 flex flex-wrap gap-2">{controls.map(([label, action]) => <button key={label} onClick={() => void action().catch((error) => log(label, { error: error.message }))} className="rounded border border-[#ddddda] bg-white px-3 py-1.5 text-xs hover:bg-[#eeeeeb]">{label}</button>)}<button onClick={() => setLogs([])} className="rounded border border-[#ddddda] bg-white px-3 py-1.5 text-xs hover:bg-[#eeeeeb]">Clear log</button></div><pre className="mt-5 max-h-[58vh] overflow-auto rounded border border-[#ddddda] bg-white p-3 text-xs leading-5">{JSON.stringify({ state, logs }, null, 2)}</pre></main>;
}
