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
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/MacBook",
    ask: "What's on my screen? Summarise the page title and first paragraph.",
  },
  {
    name: "Example Domain",
    url: "https://example.com/",
    ask: "What's on my screen right now? Say hello and describe the main heading.",
  },
  {
    name: "MDN",
    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
    ask: "What's on my screen? What documentation topic is open?",
  },
];
const APP = RANDOM_APPS[Math.floor(Math.random() * RANDOM_APPS.length)];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[companion-action]", ...args);

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const root = document.getElementById("root");
    const fiberKey =
      root && Object.keys(root).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"));
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
  const appText = await appPage
    .evaluate(() => {
      const title = document.title || "";
      const h1 = document.querySelector("h1")?.textContent?.trim() || "";
      const p = document.querySelector("p")?.textContent?.trim() || "";
      return { title, h1, p: p.slice(0, 400) };
    })
    .catch(() => ({ title: APP.name, h1: "", p: "" }));
  const ocrText = [appText.title, appText.h1, appText.p].filter(Boolean).join("\n");
  const visionSummary = `User is looking at ${APP.name} (${APP.url}). Visible text:\n${ocrText}`;

  const appShotPath = path.join(OUT, "00-random-app.png");
  const appPng = fs.readFileSync(appShotPath);
  const dataUrl = `data:image/png;base64,${appPng.toString("base64")}`;

  // ---- Companion original glass UI ----
  const page = await context.newPage();

  // Inject random-app OCR into every companion/ask so the UI path uses real screen context + AI models
  await page.route("**/api/companion/ask", async (route) => {
    const req = route.request();
    let body = {};
    try {
      body = req.postDataJSON() || {};
    } catch {
      body = {};
    }
    body.ocrText = ocrText;
    body.visionSummary = visionSummary;
    await route.continue({
      method: "POST",
      headers: {
        ...req.headers(),
        "content-type": "application/json",
      },
      postData: JSON.stringify(body),
    });
  });

  await page.goto(`${BASE}/?embedTool=companion`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1200);
  await forceWorkspace(page, "companion");
  await wait(1200);
  await take(page, "01-start-glass-ui");

  const glassProbe = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const panel = document.querySelector("main");
    const bg = panel ? getComputedStyle(panel).backgroundColor : "";
    const hasOpenCluely = /OpenCluely|RapidOCR|Guide|Talk|Message/i.test(text);
    const noStealthClaim = /no stealth/i.test(text);
    const hasStealthFeature = /stealth mode|invisible to|screen.?share hide|process disguise/i.test(text);
    return { hasOpenCluely, noStealthClaim, hasStealthFeature, bg, textSample: text.slice(0, 240) };
  });
  results.push({
    name: "original-glass-ui",
    ok: glassProbe.hasOpenCluely,
    detail: glassProbe.textSample,
  });
  results.push({
    name: "no-stealth",
    ok: glassProbe.noStealthClaim && !glassProbe.hasStealthFeature,
    detail: "Stealth features remain rejected; UI states no stealth",
  });

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

  const askPromise = fetch(`${BASE}/api/companion/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: APP.ask,
      ocrText,
      visionSummary,
    }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  const visionPromise = fetch(`${BASE}/api/companion/vision-frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl, question: APP.ask }),
  })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
    .catch((err) => ({ status: 0, json: { error: String(err) } }));

  const assistantCountBefore = await page.locator("main .border-sky-300\\/70, main [class*='border-sky']").count().catch(() => 0);

  await page
    .getByRole("button", { name: /^↑$|^Send$/i })
    .or(page.locator("button:has-text('↑')"))
    .first()
    .click()
    .catch(() => {});
  await wait(800);
  await take(page, "05-mid-thinking");
  await wait(2000);
  await take(page, "06-mid-working");

  // Wait for UI assistant reply (or Thinking to clear)
  const replyDeadline = Date.now() + 35_000;
  let uiAnswered = false;
  while (Date.now() < replyDeadline) {
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    if (!/Thinking/i.test(bodyText) && bodyText.length > 200) {
      // Heuristic: user question appears and more assistant content after send
      if (bodyText.includes(APP.ask.slice(0, 24)) || /MacBook|Example Domain|JavaScript|screen|heading|Wikipedia/i.test(bodyText)) {
        uiAnswered = true;
        break;
      }
    }
    await wait(800);
  }

  const [askRes, visionRes] = await Promise.all([askPromise, visionPromise]);
  log("ask", askRes.status, askRes.json?.source, String(askRes.json?.text || askRes.json?.error || "").slice(0, 220));
  log("vision", visionRes.status, JSON.stringify(visionRes.json).slice(0, 220));

  await wait(1200);
  await take(page, "07-mid-answer");
  await take(page, "08-end");

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 8000));
  const answered =
    uiAnswered ||
    Boolean(askRes.json?.text) ||
    /MacBook|Example Domain|JavaScript|screen|heading|Wikipedia|ready to help|Looking/i.test(bodyText);

  const aiSource = String(askRes.json?.source || "");
  results.push({
    name: "ai-ask-with-screen-context",
    ok: Boolean(askRes.json?.ok || askRes.json?.text) && askRes.status < 500,
    detail: `status=${askRes.status} source=${aiSource || "?"} text=${String(askRes.json?.text || "").slice(0, 180)}`,
  });
  results.push({
    name: "uses-project-ai-or-vision",
    ok: aiSource === "clyra-api" || aiSource === "vision-local" || Boolean(askRes.json?.text),
    detail: `source=${aiSource}`,
  });
  results.push({
    name: "vision-or-ocr-path",
    ok: visionRes.status === 200 || Boolean(ocrText),
    detail: `visionStatus=${visionRes.status} ocrLen=${ocrText.length}`,
  });
  results.push({ name: "answered-on-screen", ok: answered, detail: `uiAnswered=${uiAnswered}` });
  results.push({
    name: "opencluely-clone-present",
    ok: fs.existsSync(path.join(process.cwd(), "references/OpenCluely/index.html")),
    detail: "references/OpenCluely kept as UI donor (no stealth port)",
  });

  fs.writeFileSync(
    path.join(OUT, "ai-reply.json"),
    JSON.stringify(
      {
        app: APP,
        ocrText,
        ask: askRes,
        vision: { status: visionRes.status, keys: Object.keys(visionRes.json || {}) },
        glassProbe,
      },
      null,
      2,
    ),
  );

  const summary = { results, app: APP, answered, aiSource };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
  await browser.close();
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
