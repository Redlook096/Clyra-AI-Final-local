/**
 * AI Browser MacBook M2 pricing task — welcome start, mid-work, end screenshots.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/browser-macbook";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[browser-macbook]", ...args);

const TASK =
  process.env.BROWSER_TASK ||
  "Look at MacBook M2 options and find the best one for pricing. Compare a few listings and recommend the best value.";

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
  await page.screenshot({ path: path.join(SCREENSHOTS, `browser-macbook-${name}.png`), fullPage: false });
  log("shot", dest);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });

  await page.goto(`${BASE}/?embedTool=browser`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1200);
  await forceWorkspace(page, "browser");
  await wait(2500);

  // START — welcome screen
  const welcome = await page.locator(".clyra-browser-start").isVisible().catch(() => false);
  await take(page, "01-start-welcome");
  log("welcome visible", welcome);

  // Open ask + fill
  const askBtn = page.getByRole("button", { name: /Ask Clyra/i });
  if (await askBtn.count()) await askBtn.first().click();
  await wait(700);
  await take(page, "02-ask-open");

  const taskBox = page.getByPlaceholder(/Describe a task/i);
  await taskBox.fill(TASK);
  await wait(400);
  await take(page, "03-before-send");

  await page.getByRole("button", { name: /Run browser task/i }).click();
  await wait(1600);
  await take(page, "04-mid-sidebar-open");
  await wait(3500);
  await take(page, "05-mid-working");
  await wait(5000);
  await take(page, "06-mid-working-2");

  let finished = false;
  let content = "";
  for (let i = 0; i < 48; i++) {
    await wait(3000);
    if (i === 2) await take(page, "07-mid-working-3");
    if (i === 6) await take(page, "08-mid-working-4");
    const text = await page.evaluate(() => document.body.innerText.slice(0, 12000));
    if (/Task completed|best value|MacBook|pricing|recommend/i.test(text) && /Task completed|I'll work|heading|listing|\$|AUD|USD/i.test(text)) {
      // keep waiting for completion card if busy
    }
    if (/Task completed/i.test(text) || (/The best|recommend|best value|priced/i.test(text) && !/Building a plan|Reading|Comparing|Searching/i.test(text) && i > 4)) {
      finished = /Task completed|best|recommend|MacBook|pricing|\$/i.test(text);
      content = text.slice(0, 500);
      if (/Task completed/i.test(text)) break;
    }
    if (i > 20 && /Task not completed|could not|error/i.test(text)) break;
  }

  await wait(1000);
  await take(page, "09-end");
  await take(page, "10-end-final");

  const result = { welcome, finished, content: content.slice(0, 400), task: TASK };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!finished) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
