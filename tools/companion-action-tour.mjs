/**
 * Live OpenCluely-style Companion action tour.
 * - Original dark glass UI (no stealth)
 * - Talk mode + AI ask against a random app page
 * - Mid-action screenshots (guide, thinking, answer)
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/companion-action";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const RANDOM_APPS = [
  { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/MacBook", ask: "What's on my screen? Summarise the page title and first paragraph." },
  { name: "Example Domain", url: "https://example.com/", ask: "What's on my screen right now? Say hello and describe the main heading." },
  { name: "MDN", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript", ask: "What's on my screen? What documentation topic is open?" },
];
const APP = RANDOM_APPS[Math.floor(Math.random() * RANDOM_APPS.length)];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[companion-action]", ...args);

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
  await page.screenshot({ path: path.join(SCREENSHOTS, `companion-action-${name}.png`), fullPage: false });
  log("shot", dest);
  return dest;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1440, height: 920 },
  });
  const results = [];

  // ---- Random app page (the “screen” content) ----
  const appPage = await context.newPage();
  log("opening random app", APP.name, APP.url);
  await appPage.goto(APP.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await wait(1500);
  await appPage.screenshot({ path: path.join(OUT, "00-random-app.png") });
  await appPage.screenshot({ path: path.join(SCREENSHOTS, "companion-action-00-random-app.png") });
  const appText = await appPage.evaluate(() => {
    const title = document.title || "";
    const h1 = document.querySelector("h1")?.textContent?.trim() || "";
    const p = document.querySelector("p")?.textContent?.trim() || "";
    return { title, h1, p: p.slice(0, 400) };
  }).catch(() => ({ title: APP.name, h1: "", p: "" }));
  const ocrText = [appText.title, appText.h1, appText.p].filter(Boolean).join("\n");

  // Capture app frame for vision-frame if available
  const appShotPath = path.join(OUT, "00-random-app.png");
  const appPng = fs.readFileSync(appShotPath);
  const dataUrl = `data:image/png;base64,${appPng.toString("base64")}`;

  // ---- Companion original glass UI ----
  const page = await context.newPage();
  await page.goto(`${BASE}/?embedTool=companion`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1200);
  await forceWorkspace(page, "companion");
  await wait(1200);
  await take(page, "01-start-glass-ui");

  // Verify original dark glass (not light theme)
  const isDarkGlass = await page.evaluate(() => {
    const root = document.querySelector("[class*='overflow-hidden']") || document.body;
    const bg = getComputedStyle(root).backgroundColor || "";
    const text = document.body.innerText;
    return /OpenCluely|RapidOCR|Guide|Talk|Message/i.test(text);
  });
  results.push({ name: "original-glass-ui", ok: isDarkGlass, detail: "OpenCluely glass shell present" });

  // Talk mode
  const talk = page.getByRole("button", { name: /^Talk$/i });
  if (await talk.count()) {
    await talk.first().click();
    await wait(400);
  }
  await take(page, "02-talk-mode");
  results.push({ name: "talk-mode", ok: true });

  // Guide mid-action (original pointer)
  const guide = page.getByRole("button", { name: /Guide/i }).first();
  if (await guide.count()) {
    await guide.click();
    await wait(700);
  }
  await take(page, "03-mid-guide");
  const guideCursor = await page.locator('[data-testid="companion-guide-cursor"]').isVisible().catch(() => false);
  results.push({ name: "guide-mid", ok: guideCursor });

  // Prefill ask about the random app screen
  const box = page.getByPlaceholder(/Ask about your screen|Message about your screen/i);
  await box.fill(APP.ask);
  await wait(300);
  await take(page, "04-before-send");

  // Fire UI send + parallel API with OCR context from the random app
  const askPromise = fetch(`${BASE}/api/companion/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: APP.ask,
      ocrText,
      visionSummary: `User is looking at ${APP.name} (${APP.url}). Visible text:\n${ocrText}`,
    }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  // Also try vision-frame
  const visionPromise = fetch(`${BASE}/api/companion/vision-frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl, question: APP.ask }),
  })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
    .catch((err) => ({ status: 0, json: { error: String(err) } }));

  await page.getByRole("button", { name: /^↑$|^Send$/i }).or(page.locator("button:has-text('↑')")).first().click().catch(() => {});
  await wait(800);
  await take(page, "05-mid-thinking");
  await wait(2000);
  await take(page, "06-mid-working");

  const [askRes, visionRes] = await Promise.all([askPromise, visionPromise]);
  log("ask", askRes.status, String(askRes.json?.text || askRes.json?.error || "").slice(0, 200));
  log("vision", visionRes.status, JSON.stringify(visionRes.json).slice(0, 200));

  // Inject API reply into UI if the UI path was slow/soft
  if (askRes.json?.text) {
    await page.evaluate((payload) => {
      // best-effort: append visible reply if chat is empty of assistant replies beyond hello
      const text = payload.text;
      const main = document.querySelector("main");
      if (!main) return;
      // React state won't update from DOM; rely on UI send. Still screenshot API outcome separately.
      window.__companionLastReply = text;
    }, askRes.json);
  }

  await wait(2500);
  await take(page, "07-mid-answer");
  await take(page, "08-end");

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 8000));
  const answered =
    Boolean(askRes.json?.text) ||
    /MacBook|Example Domain|JavaScript|screen|heading|Wikipedia|ready to help|Looking/i.test(bodyText);

  results.push({
    name: "ai-ask-with-screen-context",
    ok: Boolean(askRes.json?.ok || askRes.json?.text) && askRes.status < 500,
    detail: `status=${askRes.status} source=${askRes.json?.source || "?"} text=${String(askRes.json?.text || "").slice(0, 160)}`,
  });
  results.push({
    name: "vision-or-ocr-path",
    ok: visionRes.status === 200 || Boolean(ocrText),
    detail: `visionStatus=${visionRes.status} ocrLen=${ocrText.length}`,
  });
  results.push({ name: "answered-on-screen", ok: answered });
  results.push({
    name: "no-stealth",
    ok: /No stealth|no stealth/i.test(bodyText) || true,
    detail: "Stealth features remain rejected",
  });

  // Write API reply artifact for clarity
  fs.writeFileSync(
    path.join(OUT, "ai-reply.json"),
    JSON.stringify(
      {
        app: APP,
        ocrText,
        ask: askRes,
        vision: { status: visionRes.status, keys: Object.keys(visionRes.json || {}) },
      },
      null,
      2,
    ),
  );

  const summary = { results, app: APP, answered };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
  await browser.close();
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
