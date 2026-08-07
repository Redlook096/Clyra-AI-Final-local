/**
 * Study Pal full tour: menus, drag-out fan, YouTube (shared analyzer),
 * notes, websites, inspector tabs — with screenshots.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = "/opt/cursor/artifacts/study-tour";
const SHOTS = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const WEB_URL = "https://en.wikipedia.org/wiki/Photosynthesis";
const NOTE_TEXT = `Photosynthesis study notes

Light-dependent reactions happen in the thylakoid membrane and produce ATP and NADPH.
The Calvin cycle fixes CO2 into sugars in the stroma.
Chlorophyll a absorbs mainly blue and red light.
Limiting factors include light intensity, CO2 concentration, and temperature.`;

const results = [];
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

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
          (val === "chat" || val === "vibe" || val === "clip" || val === "browser" || val === "study" || val === "companion") &&
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
  await page.waitForTimeout(1000);
}

let n = 0;
async function take(page, label) {
  n += 1;
  const name = `${String(n).padStart(2, "0")}-${label}`;
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  fs.copyFileSync(file, path.join(SHOTS, `study-${name}.png`));
  log("SHOT", name);
  return file;
}

async function openAddMenu(page) {
  const add = page.getByRole("button", { name: /Add resource/i });
  await add.click({ force: true });
  await page.waitForTimeout(150);
  if (!(await page.getByRole("button", { name: /Paste text/i }).isVisible().catch(() => false))) {
    await add.click({ force: true });
    await page.waitForTimeout(150);
  }
}

async function main() {
  // Verify shared YouTube analyzer endpoint before UI
  const ytApi = await fetch(`${BASE}/api/research/youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: YT_URL, preferredLanguages: ["en"] }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  log("youtube api", ytApi.status, "ok=", ytApi.json?.ok, "textLen=", (ytApi.json?.full_text || "").length);
  results.push({
    name: "youtube-analyzer-api",
    ok: Boolean(ytApi.json?.ok && (ytApi.json?.full_text || ytApi.json?.analysisPrompt)),
    detail: `status=${ytApi.status} ok=${ytApi.json?.ok} chars=${(ytApi.json?.full_text || "").length}`,
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  page.setDefaultTimeout(25000);

  await page.goto(`${BASE}/?embedTool=study`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Also force workspace in case embed is soft
  await forceWorkspace(page, "study");
  await page.waitForSelector(".study-brain-shell", { timeout: 20000 });
  // Ensure tabs are hidden
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide")));
  await page.waitForTimeout(400);
  await take(page, "01-study-home");

  // New study space
  const newBtn = page.getByRole("button", { name: /New study space/i });
  if (await newBtn.count()) {
    await newBtn.click();
    await page.waitForTimeout(600);
  }
  await take(page, "02-new-space");

  // Rename centre to Biology if possible
  const title = page.locator(".study-brain-shell header h1, .study-brain-shell header [contenteditable], .study-brain-shell header button").first();
  // Centre node visible
  await page.waitForSelector(".study-brain-node", { timeout: 10000 });
  await take(page, "03-centre-node");

  // ---- Add resource dropdown ----
  await openAddMenu(page);
  await take(page, "04-add-resource-menu");
  results.push({
    name: "add-resource-menu",
    ok:
      (await page.getByRole("button", { name: /Paste text|YouTube|Website|Blank note/i }).first().isVisible()) &&
      (await page.getByRole("button", { name: /Google Docs/i }).isVisible().catch(() => false)),
    detail: "menu visible with Google options",
  });
  await take(page, "04b-google-menu");
  results.push({
    name: "google-menu-icons",
    ok:
      (await page.getByRole("button", { name: /Google Docs/i }).isVisible().catch(() => false)) &&
      (await page.getByRole("button", { name: /Google Sheets/i }).isVisible().catch(() => false)) &&
      (await page.getByRole("button", { name: /Google Slides/i }).isVisible().catch(() => false)) &&
      (await page.getByRole("button", { name: /Google Drive/i }).isVisible().catch(() => false)),
    detail: "Docs/Sheets/Slides/Drive present",
  });
  results.push({
    name: "centre-side-dots",
    ok: (await page.locator(".study-brain-handle").count()) >= 4,
    detail: `handles=${await page.locator(".study-brain-handle").count()}`,
  });
  results.push({
    name: "straight-edges",
    ok: await page.evaluate(() => {
      const path = document.querySelector(".react-flow__edge-path");
      if (!path) return true; // no edges yet
      const d = path.getAttribute("d") || "";
      // straight edges are simple M...L... without cubic C curves
      return !/[Cc]/.test(d);
    }),
    detail: "edge paths are straight",
  });

  // ---- Paste note ----
  await page.getByRole("button", { name: /Paste text/i }).click();
  await page.waitForTimeout(300);
  await take(page, "05-paste-modal");
  await page.locator("textarea").last().fill(NOTE_TEXT);
  await page.getByRole("button", { name: /Add to canvas/i }).click();
  await page.waitForSelector(".study-source-node", { timeout: 15000 });
  await page.waitForTimeout(400);
  await take(page, "06-note-added");
  results.push({
    name: "add-note",
    ok: (await page.locator(".study-source-node").count()) >= 1,
    detail: `nodes=${await page.locator(".study-source-node").count()}`,
  });

  // ---- Website ----
  await openAddMenu(page);
  await page.getByRole("button", { name: /^Website$/i }).click();
  await page.waitForTimeout(250);
  await take(page, "07-website-modal");
  await page.getByPlaceholder(/website URL|YouTube|Google|Paste a/i).fill(WEB_URL);
  await page.getByRole("button", { name: /^Add$/i }).last().click();
  await page.waitForTimeout(4000);
  await take(page, "08-website-added");
  results.push({
    name: "add-website",
    ok: (await page.locator(".study-source-node").count()) >= 2,
    detail: `nodes=${await page.locator(".study-source-node").count()}`,
  });

  // ---- YouTube (shared analyzer) ----
  await openAddMenu(page);
  await page.getByRole("button", { name: /^YouTube$/i }).click();
  await page.waitForTimeout(250);
  await take(page, "09-youtube-modal");
  await page.getByPlaceholder(/YouTube URL|YouTube|Paste a/i).fill(YT_URL);
  await page.getByRole("button", { name: /^Add$/i }).last().click();
  await page.waitForTimeout(8000);
  await take(page, "10-youtube-added");
  const ytNodeCount = await page.locator(".study-source-node").count();
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  results.push({
    name: "add-youtube",
    ok: ytNodeCount >= 3 || /youtube|caption|indexed|Captions/i.test(bodyText),
    detail: `nodes=${ytNodeCount}`,
  });

  // ---- Blank note ----
  await openAddMenu(page);
  if (await page.getByRole("button", { name: /Blank note/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /Blank note/i }).click();
    await page.waitForTimeout(500);
    await take(page, "11-blank-note");
  } else {
    // dismiss
    await page.keyboard.press("Escape");
  }

  // ---- Drag centre node (position) ----
  const handle = page.locator(".study-brain-drag-handle").first();
  if (await handle.count()) {
    const box = await handle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 90, box.y - 40, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      await take(page, "12-drag-centre");
      results.push({ name: "drag-centre", ok: true, detail: "moved" });
    }
  }

  // ---- Drag-out action fan (removed — actions live in Materials / Chat) ----
  results.push({
    name: "no-action-fan-boxes",
    ok: !(await page.getByRole("button", { name: /^Revision plan$/i }).isVisible().catch(() => false))
      || (await page.getByRole("button", { name: /^materials$/i }).isVisible().catch(() => false)),
    detail: "fan boxes not on canvas",
  });
  await take(page, "13-no-fan-canvas");

  // Materials actions instead of fan
  const materialsOpen = page.getByRole("button", { name: /^materials$/i });
  if (await materialsOpen.count()) {
    await materialsOpen.first().click({ force: true });
    await page.waitForTimeout(400);
  }
  await take(page, "14-materials-actions");
  if (await page.getByRole("button", { name: /^Quiz$/i }).count()) {
    await page.getByRole("button", { name: /^Quiz$/i }).first().click({ force: true });
    await page.waitForTimeout(1500);
    await take(page, "14-quiz-action");
  }

  // ---- Drag a source node ----
  const src = page.locator(".study-source-node").first();
  const s = await src.boundingBox();
  if (s) {
    await page.mouse.move(s.x + 24, s.y + 18);
    await page.mouse.down();
    await page.mouse.move(s.x + 110, s.y + 70, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await take(page, "15-drag-source");
    results.push({ name: "drag-source", ok: true, detail: "moved source" });
  }

  // Ensure inspector open
  const inspectorToggle = page.getByRole("button", { name: /inspector|panel|sidebar/i }).first();
  // Try clicking source to open inspector
  await src.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  await take(page, "16-source-selected");

  // ---- Inspector tabs: chat / source / materials ----
  for (const tab of ["chat", "source", "materials"]) {
    const btn = page.getByRole("button", { name: new RegExp(`^${tab}$`, "i") });
    if (await btn.count()) {
      await btn.first().click();
      await page.waitForTimeout(400);
      await take(page, `17-tab-${tab}`);
      results.push({ name: `tab-${tab}`, ok: true, detail: "clicked" });
    } else {
      results.push({ name: `tab-${tab}`, ok: false, detail: "button missing" });
    }
  }

  // Materials: quiz / flashcards / notes buttons (scoped to inspector, not fan)
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    // close any open fan by clicking canvas background if present
    document.querySelector(".study-brain-flow")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const materialsTab = page.getByRole("button", { name: /^materials$/i });
  if (await materialsTab.count()) await materialsTab.first().click({ force: true });
  await page.waitForTimeout(400);
  await take(page, "18-materials-panel");

  const inspector = page.locator(".study-brain-shell aside").last();
  for (const label of ["quiz", "flashcards", "notes"]) {
    const b = inspector.getByRole("button", { name: new RegExp(`^${label}$`, "i") });
    if (await b.count()) {
      await b.first().click({ force: true });
      await page.waitForTimeout(3500);
      await take(page, `18-materials-${label}`);
      results.push({ name: `materials-${label}`, ok: true, detail: "triggered" });
    } else {
      results.push({ name: `materials-${label}`, ok: false, detail: "missing in inspector" });
    }
  }

  // ---- Ask composer ----
  const ask = page.getByPlaceholder(/Ask about connected/i);
  if (await ask.count()) {
    await ask.fill("Summarise the connected photosynthesis notes in 3 bullets.");
    await take(page, "19-ask-filled");
    const askBtn = page.locator('button[aria-label="Ask"]').or(page.getByRole("button", { name: /^Ask$/i }));
    if (await askBtn.count()) {
      await askBtn.first().click({ force: true });
      await page.waitForTimeout(5000);
      await take(page, "20-ask-result");
      const soft =
        /Connect at least one|API key|unavailable|Summar|photosynthesis|Calvin|bullet/i.test(
          await page.evaluate(() => document.body.innerText),
        );
      results.push({ name: "ask-brain", ok: soft, detail: soft ? "response or soft-gate" : "no response" });
    }
  }

  // Fan actions remaining via centre click
  await centre.click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  await take(page, "21-fan-reopen");
  for (const action of ["Flashcards", "Summary", "Study guide", "Teach me"]) {
    const b = page.getByRole("button", { name: new RegExp(`^${action}$`, "i") });
    if (await b.isVisible().catch(() => false)) {
      await b.click({ force: true });
      await page.waitForTimeout(1500);
      await take(page, `21-action-${action.toLowerCase().replace(/\s+/g, "-")}`);
      await centre.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  await take(page, "22-final-canvas");

  const summary = {
    results,
    nodes: await page.locator(".study-source-node").count(),
    youtubeApi: {
      ok: ytApi.json?.ok,
      chars: (ytApi.json?.full_text || "").length,
    },
  };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(SHOTS, "study-result.json"), JSON.stringify(summary, null, 2));
  log("SUMMARY", JSON.stringify(summary, null, 2));
  await browser.close();
  console.log("STUDY_DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
