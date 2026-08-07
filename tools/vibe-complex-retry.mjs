/**
 * Complex vibe run — capture agent attempt + auth failure (or success if keyed).
 * Takes screenshots throughout Thinking → error/complete.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = "/opt/cursor/artifacts/vibe-complex";
fs.mkdirSync(OUT, { recursive: true });

const PROMPT = `Build a complete multi-page web app called "NovaBoard" — a project management workspace.

Use vanilla HTML/CSS/JS with hash routing. Implement ALL of:
1. Dashboard with KPI cards and recent activity
2. Kanban board with HTML5 drag/drop (Backlog / In Progress / Review / Done) persisted to localStorage
3. Tasks table with filters and priority
4. Month calendar of due dates
5. Analytics charts (SVG bar + donut)
6. Settings page
7. Seed 3 projects and ~18 tasks
8. Sidebar nav + New Task modal + toasts
9. index.html + styles.css + app.js (split modules ok)

Make it polished with Clyra blue #0052fb. Ensure index.html exists so preview can start. Summarise when done.`;

const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, "retry.log"), line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const rootEl = document.querySelector("#root");
    const key = Object.keys(rootEl).find((k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"));
    let fiber = rootEl[key];
    if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
    const seen = new Set();
    function walk(f, depth = 0) {
      if (!f || depth > 100 || seen.has(f)) return false;
      seen.add(f);
      let h = f.memoizedState, i = 0;
      while (h && i < 80) {
        const val = h.memoizedState;
        if ((val === "chat" || val === "vibe" || val === "browser" || val === "study" || val === "clip") && h.queue?.dispatch) {
          h.queue.dispatch(workspace);
          return true;
        }
        h = h.next; i++;
      }
      return walk(f.child, depth + 1) || walk(f.sibling, depth + 1);
    }
    return walk(fiber);
  }, id);
  await sleep(900);
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

async function main() {
  const meta = { shots: [], startedAt: new Date().toISOString() };
  let n = 100;

  const created = await api("POST", "/api/vibe/projects", {
    name: "NovaBoard Complex Retry",
    prompt: "NovaBoard",
  });
  const projectId = created.json?.project?.id;
  if (!projectId) throw new Error("no project");
  meta.projectId = projectId;
  fs.mkdirSync(path.join("/workspace/projects", projectId, "files"), { recursive: true });
  log("project", projectId);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await forceWorkspace(page, "vibe");
  await sleep(1200);
  await page.keyboard.press("Escape");

  const take = async (label) => {
    const file = path.join(OUT, `${n++}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    meta.shots.push({ label, file });
    log("SHOT", label);
  };

  await page.getByText(/NovaBoard Complex Retry/i).first().click({ force: true }).catch(() => {});
  await sleep(800);
  await take("retry-open");

  const composer = page.locator(".clyra-code-root textarea, textarea[placeholder*='Ask'], textarea[placeholder*='Describe'], textarea[placeholder*='build']").first();
  await composer.fill(PROMPT);
  await take("retry-prompt");
  await page.locator('button[aria-label="Send"]').first().click({ force: true });
  log("sent");
  await sleep(1500);
  await take("retry-thinking");

  let sawThinking = false;
  let sawError = false;
  let sawTools = false;
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText();
    if (/Thinking/i.test(body)) {
      if (!sawThinking) {
        sawThinking = true;
        await take("retry-thinking-live");
      }
    }
    if (/401|auth failed|DEEPSEEK_API_KEY|empty response|opencode auth|Coding model/i.test(body)) {
      sawError = true;
      await take("retry-AUTH-ERROR");
      log("AUTH ERROR surfaced in UI");
      break;
    }
    if (/Reading |Editing |Creating |Running /i.test(body)) {
      sawTools = true;
      await take("retry-tool-loop");
      log("TOOL activity");
    }
    if (/file(s)? changed|Review changes/i.test(body) && !/Thinking/i.test(body)) {
      await take("retry-complete");
      meta.outcome = "complete";
      break;
    }
    await sleep(3000);
    await take("retry-wait");
  }

  // Disk files
  const filesDir = path.join("/workspace/projects", projectId, "files");
  const walk = (dir, rel = "") => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git") continue;
      const full = path.join(dir, name);
      const r = path.join(rel, name);
      if (fs.statSync(full).isDirectory()) out.push(...walk(full, r));
      else out.push(r);
    }
    return out;
  };
  meta.files = walk(filesDir);
  meta.sawThinking = sawThinking;
  meta.sawError = sawError;
  meta.sawTools = sawTools;
  meta.diag = (await api("GET", `/api/opencode/diagnostic/${encodeURIComponent(projectId)}`)).json;
  meta.outcome = meta.outcome || (sawError ? "auth-blocked" : sawTools ? "partial" : "no-progress");
  await take("retry-FINAL");
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(meta, null, 2));
  log("DONE", meta.outcome, "files=", meta.files.length);
  await browser.close();
  if (meta.outcome !== "complete") process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
