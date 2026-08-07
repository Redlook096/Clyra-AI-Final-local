/**
 * Complex NovaBoard build with DeepSeek — screenshot throughout until complete.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = "/opt/cursor/artifacts/vibe-deepseek";
const MAX_MS = Number(process.env.VIBE_MAX_MS || 20 * 60 * 1000);
fs.mkdirSync(OUT, { recursive: true });

const PROMPT = `Build a complete multi-page web app called "NovaBoard" — a project management workspace.

Use vanilla HTML + CSS + JS only (no frameworks). Hash routing. Light premium UI with accent #0052fb.

Implement ALL of these for real:
1. #/dashboard — KPI cards (projects, tasks due today, completion %, overdue), recent activity, progress bars
2. #/board — Kanban with Backlog / In Progress / Review / Done. HTML5 drag-and-drop. Persist to localStorage
3. #/tasks — filterable/sortable task table (status, priority, assignee, due date) with inline status toggle
4. #/calendar — month calendar of due dates; click a day to list tasks
5. #/analytics — SVG charts: tasks by status (bar), priority donut, 7-day completion line
6. #/settings — display name, density toggle, reset data

Data: projects[] and tasks[] in localStorage. Seed 3 projects and ~18 realistic tasks.

Chrome: left sidebar "NovaBoard" + nav, top bar search + New task modal (title, description, status, priority, assignee, due date, project). Toasts on create/move/delete. Esc closes modal.

Files: index.html, styles.css, app.js (and data.js / board.js / charts.js if helpful). index.html MUST be at project root so preview can start.

When finished, summarise what you built and ensure the app runs from index.html.`;

const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, "watch.log"), line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: res.status, json, text };
}

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const rootEl = document.querySelector("#root");
    const key = Object.keys(rootEl).find(
      (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"),
    );
    let fiber = rootEl[key];
    if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
    const seen = new Set();
    function walk(f, depth = 0) {
      if (!f || depth > 100 || seen.has(f)) return false;
      seen.add(f);
      let h = f.memoizedState;
      let i = 0;
      while (h && i < 80) {
        const val = h.memoizedState;
        if (
          (val === "chat" || val === "vibe" || val === "browser" || val === "study" || val === "clip") &&
          h.queue?.dispatch
        ) {
          h.queue.dispatch(workspace);
          return true;
        }
        h = h.next;
        i++;
      }
      return walk(f.child, depth + 1) || walk(f.sibling, depth + 1);
    }
    return walk(fiber);
  }, id);
  await sleep(1000);
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d, rel = "") => {
    for (const name of fs.readdirSync(d)) {
      if (name === ".git") continue;
      const full = path.join(d, name);
      const r = path.join(rel, name);
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else out.push({ path: r, bytes: fs.statSync(full).size });
    }
  };
  walk(dir);
  return out;
}

async function main() {
  const status = await api("GET", "/api/opencode/status");
  log("opencode status", JSON.stringify(status.json));
  if (!/deepseek/i.test(String(status.json?.model || ""))) {
    log("WARNING expected deepseek model, got", status.json?.model);
  }

  const created = await api("POST", "/api/vibe/projects", {
    name: "NovaBoard DS",
    prompt: "NovaBoard complex build",
  });
  const projectId = created.json?.project?.id;
  if (!projectId) throw new Error("project create failed: " + created.text);
  const filesDir = path.join("/workspace/projects", projectId, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  log("project", projectId);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(30_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await forceWorkspace(page, "vibe");
  await sleep(1200);
  await page.keyboard.press("Escape");

  let n = 1;
  const meta = {
    projectId,
    startedAt: new Date().toISOString(),
    shots: [],
    events: [],
    outcome: "unknown",
  };
  const take = async (label) => {
    const file = path.join(OUT, `${String(n).padStart(3, "0")}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    meta.shots.push({ label, file, at: new Date().toISOString() });
    log("SHOT", label);
    n += 1;
    return file;
  };

  const row = page.getByText(/NovaBoard DS/i).first();
  if (await row.isVisible().catch(() => false)) await row.click({ force: true });
  await sleep(800);
  await take("01-open");

  const composer = page
    .locator(".clyra-code-root textarea, textarea[placeholder*='Ask'], textarea[placeholder*='Describe'], textarea[placeholder*='build']")
    .first();
  await composer.waitFor({ state: "visible" });
  await composer.fill(PROMPT);
  await take("02-prompt-bubble");
  await page.locator('button[aria-label="Send"]').first().click({ force: true });
  log("Prompt sent");
  await sleep(2000);
  await take("03-thinking");

  const started = Date.now();
  let lastShot = Date.now();
  let lastSig = "";
  let sawThinking = false;
  let sawTools = false;
  let idleTicks = 0;
  let completeTicks = 0;

  while (Date.now() - started < MAX_MS) {
    const body = await page.locator("body").innerText();
    const thinking = /Thinking/i.test(body) && /Stop/i.test(body);
    const authFail = /401|auth failed|DEEPSEEK_API_KEY|empty response/i.test(body);
    const toolLines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) =>
        /^(Thinking|Reading|Editing|Creating|Running|Searching|Listing|Writing|Checking|Testing|Planning|Read|Edited|Created|Ran|Searched)/i.test(
          l,
        ),
      );
    const sig = toolLines.slice(-12).join(" | ");
    if (thinking) sawThinking = true;
    if (/Reading|Editing|Creating|Running|Searching|Writing/i.test(sig)) sawTools = true;

    if (authFail) {
      await take("AUTH-FAIL");
      meta.outcome = "auth-failed";
      log("Auth failure in UI — abort");
      break;
    }

    if (sig && sig !== lastSig) {
      lastSig = sig;
      meta.events.push({ at: new Date().toISOString(), sig });
      log("ACTIVITY", sig.slice(0, 240));
      const tag = (toolLines.slice(-1)[0] || "activity").slice(0, 36).replace(/[^\w]+/g, "-");
      await take(`loop-${tag}`);
      lastShot = Date.now();
      idleTicks = 0;
    } else {
      idleTicks += 1;
    }

    if (Date.now() - lastShot > 10_000) {
      await take(thinking ? "thinking" : sawTools ? "working" : "waiting");
      lastShot = Date.now();
    }

    // harness poll
    try {
      const sessions = await api("GET", `/api/opencode/sessions/${encodeURIComponent(projectId)}`);
      const list = Array.isArray(sessions.json) ? sessions.json : sessions.json?.sessions || [];
      const sessionId = list[0]?.id || meta.sessionId;
      if (sessionId) {
        meta.sessionId = sessionId;
        const diffs = await api(
          "GET",
          `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/diff`,
        );
        const diffCount = Array.isArray(diffs.json) ? diffs.json.length : diffs.json?.diffs?.length || 0;
        if (diffCount) meta.diffCount = diffCount;
      }
    } catch (e) {
      log("poll err", String(e).slice(0, 100));
    }

    const files = listFiles(filesDir);
    meta.files = files;
    const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f.path));
    const hasJs = files.some((f) => /\.(js|css)$/i.test(f.path));
    const completeHint = /file(s)? changed|Review changes/i.test(body);

    if ((completeHint || (hasIndex && hasJs && files.length >= 3)) && !thinking) completeTicks += 1;
    else completeTicks = 0;

    if (sawTools && hasIndex && !thinking && idleTicks >= 5 && completeTicks >= 2) {
      meta.outcome = "complete";
      log("Completion detected");
      break;
    }
    if (hasIndex && hasJs && files.length >= 5 && !thinking && idleTicks >= 8 && sawThinking && sawTools) {
      meta.outcome = "complete-soft";
      log("Soft completion");
      break;
    }

    await sleep(2500);
  }

  if (meta.outcome === "unknown") {
    meta.outcome = Date.now() - started >= MAX_MS ? "timeout" : "stopped";
  }

  await take("FINAL-pre-preview");
  const preview = await api("POST", "/api/vibe/preview/start", { projectId });
  meta.previewStart = preview.json || preview.text;
  log("preview start", JSON.stringify(meta.previewStart).slice(0, 300));

  let previewReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await api("GET", `/api/vibe/preview/status/${encodeURIComponent(projectId)}`);
    const statusName = st.json?.session?.status || st.json?.status;
    const url = st.json?.session?.url || st.json?.url;
    log("preview", statusName, url || "");
    meta.previewStatus = st.json;
    if (statusName === "ready" || statusName === "running") {
      previewReady = true;
      break;
    }
    if (statusName === "build_failed") break;
  }

  const browserTab = page.getByRole("button", { name: /^Browser$/i }).first();
  if (await browserTab.isVisible().catch(() => false)) {
    await browserTab.click({ force: true });
    await sleep(1000);
  }
  const retry = page.getByRole("button", { name: /^Retry$/i }).first();
  if (await retry.isVisible().catch(() => false)) {
    await retry.click({ force: true });
    await sleep(4000);
  }

  await take("FINAL");
  meta.previewReady = previewReady;
  meta.sawThinking = sawThinking;
  meta.sawTools = sawTools;
  meta.endedAt = new Date().toISOString();
  meta.durationMs = Date.now() - started;
  meta.files = listFiles(filesDir);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(meta, null, 2));
  log(
    "DONE",
    `outcome=${meta.outcome}`,
    `files=${meta.files.length}`,
    `shots=${meta.shots.length}`,
    `previewReady=${previewReady}`,
    `sec=${Math.round(meta.durationMs / 1000)}`,
  );
  await browser.close();

  if (meta.outcome !== "complete" && meta.outcome !== "complete-soft") process.exitCode = 1;
  if (!sawTools || meta.files.length < 2) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  fs.writeFileSync(path.join(OUT, "fatal.json"), JSON.stringify({ error: String(err) }, null, 2));
  process.exit(1);
});
