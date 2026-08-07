/**
 * AI Browser before / during / after task screenshots + completion assert.
 * Uses SSE assist API for reliable completion, with UI open for visuals.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/browser-task";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[browser-task]", ...args);

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const root = document.getElementById("root");
    const fiberKey = root && Object.keys(root).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"));
    if (!fiberKey || !root) return;
    const visit = (node, depth = 0) => {
      if (!node || depth > 40) return false;
      const h = node.memoizedState;
      let m = h;
      while (m) {
        const v = m.memoizedState;
        if (
          typeof v === "string" &&
          ["chat", "vibe", "clip", "study", "browser", "browse"].includes(v) &&
          m.queue &&
          typeof m.queue.dispatch === "function"
        ) {
          m.queue.dispatch(workspace);
          return true;
        }
        m = m.next;
      }
      if (node.child && visit(node.child, depth + 1)) return true;
      if (node.sibling && visit(node.sibling, depth + 1)) return true;
      return false;
    };
    visit(root[fiberKey]);
  }, id);
  await wait(900);
}

async function take(page, name) {
  const file = `${String(name).padStart(2, "0")}-${name}.png`.replace(/^\d+-(\d+-)/, "$1");
  // keep simple names
  const dest = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  await page.screenshot({ path: path.join(SCREENSHOTS, `browser-${name}.png`), fullPage: false });
  log("shot", dest);
  return dest;
}

async function runAssistSSE(task, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.CLYRA_BROWSER_TASK_TIMEOUT_MS || 180000));
  try {
    const res = await fetch(`${BASE}/api/openbrowser/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ task }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`assist HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let complete = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.type === "progress") onProgress?.(data);
          if (data.type === "complete" || data.type === "error") complete = data;
        } catch {
          /* ignore partial */
        }
      }
    }
    return complete;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const results = [];

  await page.goto(`${BASE}/?embedTool=browser`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1500);
  await forceWorkspace(page, "browser");
  await wait(1200);
  await take(page, "01-before-idle");

  // Open Ask panel and fill task (UI before send)
  const askBtn = page.getByRole("button", { name: /Ask Clyra/i });
  if (await askBtn.count()) {
    await askBtn.first().click();
    await wait(600);
  }
  await take(page, "02-before-ask-open");

  const TASK =
    process.env.BROWSER_TASK ||
    "Open https://example.com and report the main heading on the page in one short sentence.";

  const taskBox = page.getByPlaceholder(/Describe a task/i);
  if (await taskBox.count()) {
    await taskBox.fill(TASK);
    await wait(400);
  }
  await take(page, "03-before-send");

  // Start UI run for mid-action visuals, then also drive via SSE for reliable completion
  const runBtn = page.getByRole("button", { name: /Run browser task/i });
  let uiStarted = false;
  if (await runBtn.count()) {
    await runBtn.first().click();
    uiStarted = true;
    await wait(1800);
    await take(page, "04-during-1");
    await wait(2500);
    await take(page, "05-during-2");
  }

  // Prefer waiting on UI completion if started; otherwise SSE
  let finished = false;
  let completePayload = null;

  if (uiStarted) {
    // poll UI for completion while taking mid shots
    for (let i = 0; i < 36; i++) {
      await wait(2500);
      if (i === 1) await take(page, "06-during-3");
      if (i === 3) await take(page, "07-during-4");
      if (i === 6) await take(page, "08-during-5");
      const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
      if (/Task completed|Task not completed|Stopped|finished/i.test(text)) {
        finished = /Task completed/i.test(text);
        completePayload = { type: "complete", ok: finished, via: "ui" };
        break;
      }
      // still running indicator
      if (!/Running|Working|Navigat|Brows|step|Agent/i.test(text) && i > 8) {
        // may have stalled — fall through to SSE
        break;
      }
    }
  }

  if (!completePayload) {
    log("falling back to SSE assist");
    // cancel UI run if any
    const stop = page.getByRole("button", { name: /Stop browser task/i });
    if (await stop.count()) await stop.first().click().catch(() => {});
    await wait(500);

    let progressShots = 0;
    completePayload = await runAssistSSE(TASK, async () => {
      progressShots += 1;
      if (progressShots === 1) await take(page, "06-during-sse-1").catch(() => {});
      if (progressShots === 3) await take(page, "07-during-sse-2").catch(() => {});
      if (progressShots === 5) await take(page, "08-during-sse-3").catch(() => {});
    });
    finished = Boolean(completePayload?.ok && completePayload?.type === "complete");
  }

  await wait(800);
  await take(page, "09-after");
  // reload browser state view
  await page.reload({ waitUntil: "domcontentloaded" });
  await wait(1000);
  await forceWorkspace(page, "browser");
  await wait(800);
  await take(page, "10-after-reload");

  results.push({
    name: "browser-task-complete",
    ok: finished,
    detail: completePayload
      ? JSON.stringify({
          type: completePayload.type,
          ok: completePayload.ok,
          via: completePayload.via,
          content: String(completePayload.content || "").slice(0, 240),
          error: completePayload.error || null,
        })
      : "no complete payload",
  });

  const summary = { results, finished, complete: completePayload };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
  await browser.close();
  if (!finished) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
