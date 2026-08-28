const fs = require("fs");
const BASE = "http://localhost:3000";
const LOG = "/tmp/clyra-realrun.log";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

function log(line) { fs.appendFileSync(LOG, line + "\n"); }

async function json(url, init) {
  const r = await fetch(BASE + url, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body && body.error) || `${url} failed (${r.status})`);
  return body;
}

async function runPrompt(name, prompt) {
  log(`\n===== RUN: ${name} =====`);
  log(`prompt: ${prompt}`);
  const { project } = await json("/api/vibe/projects", { method: "POST", body: JSON.stringify({ name, prompt }) });
  log(`project: ${project.id}`);
  await json("/api/opencode/runtime/start", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
  const session = await json("/api/opencode/sessions", { method: "POST", body: JSON.stringify({ projectId: project.id, title: name }) });
  log(`session: ${session.id}`);
  await json(`/api/opencode/sessions/${encodeURIComponent(project.id)}/${encodeURIComponent(session.id)}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) });
  log("prompt sent; polling…");

  const started = Date.now();
  let finalText = "";
  let toolKinds = new Set();
  let lastState = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const msgs = await json(`/api/opencode/sessions/${encodeURIComponent(project.id)}/${encodeURIComponent(session.id)}/messages`);
    const assistantMsgs = msgs.filter((m) => m.info?.role === "assistant");
    const allParts = assistantMsgs.flatMap((m) => m.parts || []);
    for (const p of allParts) {
      if (p.type === "tool" && p.tool) toolKinds.add(`${p.tool}:${p.state?.status}`);
      if (p.type === "text" && p.text) finalText = String(p.text);
    }
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    const lastPart = lastMsg && (lastMsg.parts || []).slice(-1)[0];
    const done = lastPart && lastPart.type === "text" && lastPart.text;
    lastState = done ? "complete" : `running (${allParts.length} parts, ${toolKinds.size} tool kinds)`;
    const elapsed = Math.round((Date.now() - started) / 1000);
    log(`[${elapsed}s] ${lastState}`);
    if (done) break;
    if (elapsed * 1000 > RUN_TIMEOUT_MS) { lastState = "timeout"; break; }
  }

  log(`RESULT: ${lastState}`);
  log(`FINAL TEXT: ${(finalText || "").trim().slice(0, 400) || "(none)"}`);
  log(`TOOLS: ${[...toolKinds].join(", ") || "(none)"}`);
  return { name, state: lastState, finalText, toolKinds: [...toolKinds] };
}

(async () => {
  const web = await runPrompt("qa-website-e2e", "Build a small one-page website for a bakery called Rye & Salt: a single index.html with a heading and one short paragraph.");
  const passed = web.state === "complete";
  log(`\n===== OVERALL: ${passed ? "PASS" : "FAIL"} (web=${web.state}) =====`);
  process.exit(0);
})().catch((e) => { log("CRASH: " + (e && e.message)); process.exit(2); });
