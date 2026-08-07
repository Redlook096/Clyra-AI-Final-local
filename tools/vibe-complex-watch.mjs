/**
 * Complex Vibe Coder end-to-end watch:
 * - Create project
 * - Send a large multi-file build prompt
 * - Screenshot every few seconds through agent loops
 * - Poll OpenCode harness (messages/diff/diagnostic)
 * - Wait for completion + preview build
 * - Final screenshot
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = "/opt/cursor/artifacts/vibe-complex";
const MAX_MS = Number(process.env.VIBE_MAX_MS || 18 * 60 * 1000); // 18 min
const SHOT_EVERY_MS = 8_000;

fs.mkdirSync(OUT, { recursive: true });

const COMPLEX_PROMPT = `Build a complete, polished multi-page web app called "NovaBoard" — a project management workspace.

Requirements (implement ALL of these for real, not stubs):

1. Tech: vanilla HTML + CSS + JS only (no frameworks). Single-page app with hash routing. Modern, clean light UI with Clyra-blue accent #0052fb. Responsive.

2. Pages / views (hash routes):
   - #/dashboard — KPI cards (total projects, tasks due today, completion %, overdue), recent activity list, mini progress bars
   - #/board — Kanban board with columns: Backlog, In Progress, Review, Done. Cards are draggable between columns (HTML5 drag/drop). Persist to localStorage.
   - #/tasks — filterable/sortable task table (status, priority, assignee, due date). Inline status toggle.
   - #/calendar — month calendar showing tasks by due date; click a day to see tasks
   - #/analytics — simple charts with CSS/SVG: tasks by status (bar), completion over last 7 days (line), priority breakdown (donut)
   - #/settings — theme density toggle, display name, reset data button

3. Data model in localStorage:
   - projects[], tasks[] with id, title, description, status, priority (low/med/high), assignee, dueDate, projectId, createdAt, updatedAt
   - Seed with 3 projects and ~18 realistic tasks so the UI isn't empty

4. Chrome:
   - Left sidebar with logo "NovaBoard", nav links, active state
   - Top bar with search (filters tasks live), "+ New task" modal
   - New task modal: title, description, status, priority, assignee, due date, project

5. Polish:
   - Empty states, hover states, focus rings
   - Keyboard: Esc closes modal, Enter submits when focused in modal
   - Toast notifications on create/move/delete
   - index.html entry + styles.css + app.js (and split modules if helpful: data.js, board.js, charts.js)
   - npm scripts not required; just open index.html via a tiny static server or plain files

6. Quality bar:
   - Actually working drag-and-drop on the board
   - Actually working routing
   - Actually working localStorage persistence across reload
   - No placeholder "TODO" pages

When done: ensure index.html exists at the project root so preview can start, run a quick sanity check, and summarise what you built.`;

const log = (...args) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${args.join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, "watch.log"), line + "\n");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const rootEl = document.querySelector("#root");
    if (!rootEl) return false;
    const key = Object.keys(rootEl).find(
      (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"),
    );
    if (!key) return false;
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
          (val === "chat" ||
            val === "vibe" ||
            val === "clip" ||
            val === "browser" ||
            val === "study" ||
            val === "companion") &&
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

function shotName(n, label) {
  return path.join(OUT, `${String(n).padStart(3, "0")}-${label}.png`);
}

async function readUiSignals(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";
    const actions = [];
    const rows = document.querySelectorAll(".clyra-code-root [class*='Action'], .clyra-code-root button, .clyra-code-root .cc-mono");
    // Heuristic: collect interesting lines from the conversation column
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const interesting = lines.filter((l) =>
      /^(Thinking|Reading|Editing|Creating|Running|Searching|Listing|Writing|Checking|Completed|Inspecting|Todo|✓)/i.test(
        l,
      ) ||
      /\+\d+\s+[−\-]\d+/.test(l) ||
      /file(s)? changed/i.test(l) ||
      /Review changes/i.test(l) ||
      /Preview is|Ready|build/i.test(l),
    );
    const thinking = /Thinking/i.test(body) && /Stop/i.test(body);
    const completeHint =
      /file(s)? changed/i.test(body) ||
      /Review changes/i.test(body) ||
      (/NovaBoard/i.test(body) && /built|complete|done|summary/i.test(body));
    const error = /ENOENT|Failed spawn|spawn opencode|run failed|Permission denied/i.test(body);
    return {
      thinking,
      completeHint,
      error,
      interesting: interesting.slice(-25),
      bodyLen: body.length,
      sample: lines.slice(0, 8),
    };
  });
}

async function main() {
  const meta = {
    startedAt: new Date().toISOString(),
    shots: [],
    events: [],
    projectId: null,
    sessionId: null,
    outcome: "unknown",
  };

  log("Starting complex Vibe watch against", BASE);

  // Create project via API first for a stable id
  const created = await api("POST", "/api/vibe/projects", {
    name: "NovaBoard Complex",
    prompt: "NovaBoard project management workspace",
  });
  const projectId = created.json?.project?.id || created.json?.id;
  if (!projectId) throw new Error("Failed to create project: " + created.text);
  meta.projectId = projectId;
  log("Created project", projectId);

  // Ensure files dir exists
  const filesDir = path.join("/workspace/projects", projectId, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(30_000);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await forceWorkspace(page, "vibe");
  await sleep(1500);

  // Dismiss modals
  await page.keyboard.press("Escape");
  await sleep(300);

  // Click the project in sidebar
  const projectRow = page.getByText(/NovaBoard Complex/i).first();
  if (await projectRow.isVisible().catch(() => false)) {
    await projectRow.click();
    await sleep(1000);
  } else {
    // Reload projects by toggling workspace
    await forceWorkspace(page, "chat");
    await sleep(400);
    await forceWorkspace(page, "vibe");
    await sleep(1200);
    await page.getByText(/NovaBoard Complex/i).first().click({ force: true }).catch(() => {});
    await sleep(800);
  }

  let n = 1;
  const take = async (label) => {
    const file = shotName(n++, label);
    await page.screenshot({ path: file, fullPage: false });
    meta.shots.push({ label, file, at: new Date().toISOString() });
    log("SHOT", label, "->", path.basename(file));
    return file;
  };

  await take("01-project-open");

  // Fill composer and send
  const composer = page
    .locator(".clyra-code-root textarea, textarea[placeholder*='Ask'], textarea[placeholder*='build'], textarea[placeholder*='Describe']")
    .first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.fill(COMPLEX_PROMPT);
  await sleep(500);
  await take("02-prompt-filled");

  const send = page.locator('button[aria-label="Send"]').first();
  await send.click({ force: true });
  log("Prompt sent — watching agent loops");
  await sleep(2000);
  await take("03-prompt-sent");

  const started = Date.now();
  let lastShot = Date.now();
  let lastInteresting = "";
  let sawThinking = false;
  let sawTool = false;
  let idleTicks = 0;
  let completeTicks = 0;

  while (Date.now() - started < MAX_MS) {
    const signals = await readUiSignals(page);
    if (signals.thinking) sawThinking = true;
    if (signals.interesting.some((l) => /Reading|Editing|Creating|Running|Searching|Writing/i.test(l))) {
      sawTool = true;
    }

    const digest = signals.interesting.join(" | ");
    if (digest && digest !== lastInteresting) {
      lastInteresting = digest;
      meta.events.push({ at: new Date().toISOString(), interesting: signals.interesting });
      log("ACTIVITY", digest.slice(0, 220));
      // Immediate shot on new activity
      await take(`loop-${signals.interesting.slice(-1)[0]?.slice(0, 40).replace(/[^\w]+/g, "-") || "activity"}`);
      lastShot = Date.now();
      idleTicks = 0;
    } else {
      idleTicks += 1;
    }

    // Periodic shot
    if (Date.now() - lastShot >= SHOT_EVERY_MS) {
      await take(signals.thinking ? "thinking" : sawTool ? "working" : "waiting");
      lastShot = Date.now();
    }

    // Poll harness APIs
    try {
      const sessions = await api("GET", `/api/opencode/sessions/${encodeURIComponent(projectId)}`);
      const list = sessions.json?.sessions || sessions.json || [];
      const sessionId =
        (Array.isArray(list) && (list[0]?.id || list[0]?.sessionID)) ||
        sessions.json?.session?.id ||
        meta.sessionId;
      if (sessionId) {
        meta.sessionId = sessionId;
        const diffs = await api(
          "GET",
          `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/diff`,
        );
        const messages = await api(
          "GET",
          `/api/opencode/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/messages`,
        );
        const diffCount = Array.isArray(diffs.json) ? diffs.json.length : diffs.json?.diffs?.length || 0;
        const msgCount = Array.isArray(messages.json) ? messages.json.length : messages.json?.messages?.length || 0;
        if (diffCount || msgCount) {
          meta.events.push({
            at: new Date().toISOString(),
            kind: "harness",
            sessionId,
            diffCount,
            msgCount,
          });
        }
      }
      const diag = await api("GET", `/api/opencode/diagnostic/${encodeURIComponent(projectId)}`);
      if (diag.json) {
        meta.lastDiagnostic = diag.json;
      }
    } catch (err) {
      log("harness poll error", String(err).slice(0, 120));
    }

    // Check files on disk
    const files = [];
    const walk = (dir, rel = "") => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const r = path.join(rel, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, r);
        else files.push(r);
      }
    };
    walk(filesDir);
    meta.files = files;

    const hasIndex = files.some((f) => /(^|\/)index\.html$/i.test(f));
    const hasJs = files.some((f) => /\.(js|ts|tsx|jsx)$/i.test(f));
    const hasCss = files.some((f) => /\.css$/i.test(f));

    if (signals.error) {
      meta.outcome = "failed-ui-error";
      await take("ERROR");
      log("UI error detected — aborting watch");
      break;
    }

    // Completion: UI hints + files on disk + not thinking for a bit
    if ((signals.completeHint || (hasIndex && hasJs && files.length >= 3)) && !signals.thinking) {
      completeTicks += 1;
    } else {
      completeTicks = 0;
    }

    // Require sustained idle after activity, with files present
    if (sawTool && hasIndex && !signals.thinking && idleTicks >= 4 && completeTicks >= 2) {
      meta.outcome = "complete";
      log("Detected completion — index.html + tools + idle");
      break;
    }

    // Soft complete: many files and no thinking for longer
    if (hasIndex && hasJs && hasCss && files.length >= 5 && !signals.thinking && idleTicks >= 6 && sawThinking) {
      meta.outcome = "complete-soft";
      log("Soft completion — multi-file project idle");
      break;
    }

    await sleep(2000);
  }

  if (meta.outcome === "unknown") {
    meta.outcome = Date.now() - started >= MAX_MS ? "timeout" : "stopped";
  }

  await take("FINAL-before-preview");

  // Try starting preview
  log("Starting preview for", projectId);
  const previewStart = await api("POST", "/api/vibe/preview/start", { projectId });
  meta.previewStart = previewStart.json || previewStart.text;
  log("preview start", JSON.stringify(meta.previewStart).slice(0, 300));

  // Poll preview up to 90s
  let previewReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const status = await api("GET", `/api/vibe/preview/status/${encodeURIComponent(projectId)}`);
    meta.previewStatus = status.json;
    const st = status.json?.session?.status || status.json?.status;
    log("preview status", st, status.json?.session?.url || status.json?.url || "");
    if (st === "ready" || st === "running") {
      previewReady = true;
      break;
    }
    if (st === "build_failed") break;
  }

  // Switch to browser tab in right panel if present
  const browserTab = page.getByRole("button", { name: /^Browser$/i }).first();
  if (await browserTab.isVisible().catch(() => false)) {
    await browserTab.click({ force: true });
    await sleep(1000);
  }
  const retry = page.getByRole("button", { name: /^Retry$/i }).first();
  if (await retry.isVisible().catch(() => false)) {
    await retry.click({ force: true });
    await sleep(5000);
  }

  await take("FINAL-after-preview");

  // List final project tree
  const listTree = (dir, prefix = "") => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) out.push(...listTree(full, prefix + name + "/"));
      else out.push({ path: prefix + name, bytes: st.size });
    }
    return out;
  };
  meta.tree = listTree(filesDir);
  meta.endedAt = new Date().toISOString();
  meta.durationMs = Date.now() - started;
  meta.previewReady = previewReady;
  meta.sawThinking = sawThinking;
  meta.sawTool = sawTool;

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(meta, null, 2));
  log(
    "DONE",
    `outcome=${meta.outcome}`,
    `files=${meta.tree.length}`,
    `shots=${meta.shots.length}`,
    `previewReady=${previewReady}`,
    `durationSec=${Math.round(meta.durationMs / 1000)}`,
  );

  await browser.close();

  // Exit non-zero if we didn't really complete
  if (!sawTool || meta.tree.length < 2 || (meta.outcome !== "complete" && meta.outcome !== "complete-soft")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  fs.writeFileSync(path.join(OUT, "fatal.json"), JSON.stringify({ error: String(err) }, null, 2));
  process.exit(1);
});
