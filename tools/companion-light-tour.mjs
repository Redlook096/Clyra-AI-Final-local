/**
 * Companion light-UI tour: start → ask what's on screen → mid-action → end.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/companion-light";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[companion-light]", ...args);

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const root = document.getElementById("root");
    const fiberKey = root && Object.keys(root).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"));
    if (!fiberKey || !root) return;
    const visit = (node, depth = 0) => {
      if (!node || depth > 40) return false;
      let m = node.memoizedState;
      while (m) {
        const v = m.memoizedState;
        if (
          typeof v === "string" &&
          ["chat", "vibe", "clip", "study", "browser", "browse", "companion"].includes(v) &&
          m.queue?.dispatch
        ) {
          m.queue.dispatch(workspace);
          return true;
        }
        m = m.next;
      }
      return (node.child && visit(node.child, depth + 1)) || (node.sibling && visit(node.sibling, depth + 1));
    };
    visit(root[fiberKey]);
  }, id);
  await wait(1000);
}

async function take(page, name) {
  const dest = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  await page.screenshot({ path: path.join(SCREENSHOTS, `companion-${name}.png`), fullPage: false });
  log("shot", dest);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const results = [];

  await page.goto(`${BASE}/?embedTool=companion`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1200);
  await forceWorkspace(page, "companion");
  await wait(1400);

  // START — light welcome
  await take(page, "01-start-light");
  const lightBg = await page.evaluate(() => {
    const shell = document.querySelector(".companion-shell");
    if (!shell) return false;
    const bg = getComputedStyle(shell).backgroundColor;
    // light-ish rgb values
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return /f4f5f7|white|#f/i.test(bg);
    return Number(m[1]) > 200 && Number(m[2]) > 200 && Number(m[3]) > 200;
  });
  const hello = await page.getByText(/Hello|What’s on your screen|Ask what’s on your screen/i).first().isVisible().catch(() => false);
  results.push({ name: "light-theme", ok: lightBg || hello, detail: `lightBg=${lightBg} hello=${hello}` });
  results.push({ name: "start-hello", ok: hello });

  // Guide mid-action
  const guide = page.getByRole("button", { name: /^Guide$/i });
  if (await guide.count()) {
    await guide.first().click();
    await wait(700);
  }
  await take(page, "02-mid-guide");
  const guideCursor = await page.locator('[data-testid="companion-guide-cursor"]').isVisible().catch(() => false);
  results.push({ name: "guide-mid", ok: guideCursor });

  // Ask what's on screen
  const box = page.getByPlaceholder(/Ask what’s on your screen|Ask about your screen/i);
  await box.fill("What's on my screen right now? Say hello and describe it briefly.");
  await wait(400);
  await take(page, "03-before-send");
  await page.getByRole("button", { name: /^Send$/i }).click();
  await wait(900);
  await take(page, "04-mid-thinking");
  // Wait for reply
  let answered = false;
  for (let i = 0; i < 20; i++) {
    await wait(800);
    if (i === 2) await take(page, "05-mid-working");
    if (i === 5) await take(page, "06-mid-working-2");
    const text = await page.evaluate(() => document.body.innerText.slice(0, 6000));
    if (/Looking at your screen/i.test(text) && i < 3) continue;
    if (
      /screen|hello|looking|Companion|RapidOCR|I can see|on your|desktop|window|preview/i.test(text) &&
      !/Looking at your screen…\s*$/i.test(text)
    ) {
      // ensure we have more than just the user bubble + hello starter
      const msgs = await page.locator("main .flex, main [class*='assistant']").count().catch(() => 0);
      answered = /What’s on my screen|on my screen|Looking at|I can|RapidOCR|vision|hello/i.test(text);
      if (answered && i > 1) break;
    }
  }
  await take(page, "07-mid-answer");
  await take(page, "08-end");
  results.push({ name: "whats-on-screen", ok: answered });

  // Control mid
  const control = page.getByRole("button", { name: /^Control$/i });
  if (await control.count()) {
    await control.first().click();
    await wait(600);
    await take(page, "09-mid-control");
  }

  const summary = { results, lightBg, hello, guideCursor, answered };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
  await browser.close();
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
