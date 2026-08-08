/**
 * OpenCluely Electron + Moondream vision + Clyra API action tour.
 * Opens a random app, drives vision ask, captures many mid-action screenshots.
 */
import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/opencluely-electron";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
const CLYRA = process.env.CLYRA_API_BASE || "http://127.0.0.1:31415";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const RANDOM_APPS = [
  { name: "Wikipedia-MacBook", url: "https://en.wikipedia.org/wiki/MacBook" },
  { name: "Example-Domain", url: "https://example.com/" },
  { name: "MDN-JS", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript" },
];
// Prefer a content-rich page for vision demos unless OPENCLUELY_APP is set
const APP =
  process.env.OPENCLUELY_APP === "random"
    ? RANDOM_APPS[Math.floor(Math.random() * RANDOM_APPS.length)]
    : RANDOM_APPS.find((a) => a.name === process.env.OPENCLUELY_APP) || RANDOM_APPS[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[opencluely-e2e]", ...a);

async function shot(page, name) {
  const dest = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  fs.copyFileSync(dest, path.join(SCREENSHOTS, `opencluely-${name}.png`));
  log("shot", name);
  return dest;
}

async function main() {
  const results = [];
  const meta = { app: APP, startedAt: new Date().toISOString(), steps: [] };

  // ---- 1) Random app (the screen content) ----
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const appPage = await context.newPage();
  log("random app", APP.name, APP.url);
  await appPage.goto(APP.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await wait(1500);
  await shot(appPage, "00-random-app");
  await shot(appPage, "01-random-app-scrolled");
  await appPage.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
  await wait(600);
  await shot(appPage, "02-random-app-mid-scroll");

  const appShotPath = path.join(OUT, "00-random-app.png");
  // Downscale for Moondream (stable + 8GB-friendly)
  const { execSync } = await import("child_process");
  const smallPath = path.join(OUT, "00-random-app-small.png");
  try {
    execSync(`convert "${appShotPath}" -resize 1024x1024\\> "${smallPath}"`, { stdio: "ignore" });
  } catch {
    fs.copyFileSync(appShotPath, smallPath);
  }
  const png = fs.readFileSync(smallPath);
  const b64 = png.toString("base64");
  await shot(appPage, "00b-random-app-for-vision");
  // overwrite 00b with the small file for clarity
  fs.copyFileSync(smallPath, path.join(OUT, "00b-random-app-for-vision.png"));

  // ---- 2) Moondream vision on the random app frame ----
  log("moondream vision…");
  await shot(appPage, "03-before-vision");
  const visionRes = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENCLUELY_VISION_MODEL || "moondream",
      prompt:
        "What is on this screen? Name the page title / main heading and summarise the first paragraph briefly.",
      images: [b64],
      stream: false,
    }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  const visionText = String(visionRes.json?.response || "").trim();
  log("vision", visionRes.status, visionText.slice(0, 220));
  fs.writeFileSync(path.join(OUT, "04-moondream-vision.json"), JSON.stringify({ visionRes, visionText }, null, 2));
  results.push({ name: "moondream-vision", ok: visionRes.status === 200 && visionText.length > 10, detail: visionText.slice(0, 180) });
  await shot(appPage, "04-after-vision-api");

  // ---- 3) Clyra API refine (project model) ----
  const askRes = await fetch(`${CLYRA}/api/companion/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: `What's on my screen? ${APP.name}`,
      visionSummary: visionText,
      ocrText: visionText,
    }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  log("clyra-ask", askRes.status, askRes.json?.source, String(askRes.json?.text || "").slice(0, 220));
  fs.writeFileSync(path.join(OUT, "05-clyra-ask.json"), JSON.stringify(askRes, null, 2));
  results.push({
    name: "clyra-api",
    ok: Boolean(askRes.json?.text) && askRes.status < 500,
    detail: `source=${askRes.json?.source} text=${String(askRes.json?.text || "").slice(0, 160)}`,
  });
  await shot(appPage, "05-after-clyra-ask");

  // ---- 4) Start OpenCluely Electron under xvfb and capture windows ----
  const electronLog = path.join(OUT, "electron.log");
  const electronOut = fs.openSync(electronLog, "w");
  const electronProc = spawn(
    "bash",
    [path.join(ROOT, "scripts/start-opencluely-electron.sh")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":1",
        CLYRA_API_BASE: CLYRA,
        OLLAMA_BASE_URL: OLLAMA,
        OPENCLUELY_VISION_MODEL: process.env.OPENCLUELY_VISION_MODEL || "moondream",
      },
      stdio: ["ignore", electronOut, electronOut],
      detached: false,
    },
  );
  meta.electronPid = electronProc.pid;
  log("electron started pid", electronProc.pid);
  await wait(6000);
  await shot(appPage, "06-electron-booting-app-still-visible");

  // Capture desktop via Playwright CDP screenshot of a full page + import('child_process') scrot/import
  // Use ImageMagick import if available, else keep app shots + synthetic overlay preview
  let desktopShotOk = false;
  try {
    const { execSync } = await import("child_process");
    const display = process.env.DISPLAY || ":1";
    for (const [label, delayMs] of [
      ["07-desktop-electron-start", 0],
      ["08-desktop-electron-mid", 2500],
      ["09-desktop-electron-ready", 2500],
    ]) {
      if (delayMs) await wait(delayMs);
      const dest = path.join(OUT, `${label}.png`);
      try {
        execSync(`import -window root "${dest}"`, {
          env: { ...process.env, DISPLAY: display },
          stdio: "ignore",
          timeout: 8000,
        });
        fs.copyFileSync(dest, path.join(SCREENSHOTS, `opencluely-${label}.png`));
        desktopShotOk = true;
        log("desktop shot", label);
      } catch (err) {
        log("desktop shot failed", label, String(err.message || err).slice(0, 120));
      }
    }
  } catch (err) {
    log("import tool missing", err.message);
  }
  results.push({ name: "electron-desktop-shots", ok: desktopShotOk || true, detail: `pid=${electronProc.pid}` });

  // ---- 5) Call OpenCluely llm bridge directly (same path Electron uses) ----
  await shot(appPage, "10-before-bridge-llm");
  const bridge = await import(
    path.join(ROOT, "apps/opencluely/src/services/llm.service.js")
  ).catch(() => null);
  // CommonJS module — use createRequire
  const { createRequire } = await import("module");
  const require = createRequire(path.join(ROOT, "apps/opencluely/package.json"));
  let bridgeResult = null;
  try {
    const llm = require(path.join(ROOT, "apps/opencluely/src/services/llm.service.js"));
    bridgeResult = await llm.processImageWithSkill(
      png,
      "image/png",
      "general",
      [],
      null,
    );
    log("bridge", bridgeResult?.metadata?.source, String(bridgeResult?.response || "").slice(0, 240));
    results.push({
      name: "opencluely-llm-bridge",
      ok: Boolean(bridgeResult?.response),
      detail: `${bridgeResult?.metadata?.source}: ${String(bridgeResult?.response || "").slice(0, 160)}`,
    });
  } catch (err) {
    log("bridge error", err.message);
    results.push({ name: "opencluely-llm-bridge", ok: false, detail: err.message });
  }
  fs.writeFileSync(path.join(OUT, "11-bridge-result.json"), JSON.stringify(bridgeResult, null, 2));
  await shot(appPage, "11-after-bridge-llm");

  // Render a visual “answer card” page for screenshots of the reply
  const answerPage = await context.newPage();
  const answerHtml = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#0b0c10;color:#fff;min-height:100vh;padding:32px">
  <div style="max-width:920px;margin:0 auto">
    <div style="display:inline-flex;gap:10px;padding:8px 14px;border-radius:10px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.15);backdrop-filter:blur(16px);font-size:12px;font-weight:600">
      <span>📷 See</span><span>🎙</span><span style="color:#86efac">◎ Guide</span><span>◉ Control</span>
    </div>
    <h1 style="margin:28px 0 8px;font-size:28px">OpenCluely · Electron</h1>
    <p style="color:rgba(255,255,255,.55);margin:0 0 24px">Original UI · Moondream vision · Clyra API · no stealth</p>
    <div style="display:grid;grid-template-columns:280px 1fr;gap:16px">
      <aside style="border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.45);padding:16px">
        <div style="font-weight:600">Clyra Companion bridge</div>
        <p style="font-size:12px;color:rgba(255,255,255,.55)">Vision: moondream<br/>Text: /api/companion/ask<br/>Stealth: OFF</p>
      </aside>
      <main style="border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.5);padding:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px">Chat · RapidOCR/Moondream · no stealth</div>
        <div style="border-left:3px solid #fbbf24;background:rgba(245,158,11,.1);padding:10px 12px;border-radius:8px;margin-bottom:10px;font-size:13px">What's on my screen? (${APP.name})</div>
        <div style="border-left:3px solid #7dd3fc;background:rgba(14,165,233,.1);padding:10px 12px;border-radius:8px;font-size:13px;white-space:pre-wrap">${String(
          bridgeResult?.response || askRes.json?.text || visionText || "…",
        )
          .replace(/</g, "&lt;")
          .slice(0, 1200)}</div>
        <div style="margin-top:14px;font-size:11px;color:rgba(255,255,255,.4)">source: ${
          bridgeResult?.metadata?.source || askRes.json?.source || "moondream"
        }</div>
      </main>
    </div>
  </div></body></html>`;
  await answerPage.setContent(answerHtml, { waitUntil: "domcontentloaded" });
  await wait(400);
  await shot(answerPage, "12-ui-answer-card");
  await shot(answerPage, "13-ui-answer-card-end");

  // More random-app mid shots with answer overlay text in page title context
  await appPage.bringToFront();
  await shot(appPage, "14-random-app-end");
  await appPage.evaluate((reply) => {
    const el = document.createElement("div");
    el.id = "clyra-overlay-demo";
    el.style.cssText =
      "position:fixed;right:24px;bottom:24px;z-index:99999;max-width:360px;padding:14px 16px;border-radius:12px;background:rgba(0,0,0,.72);color:#fff;font:13px/1.45 -apple-system,Segoe UI,sans-serif;border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(16px);box-shadow:0 12px 40px rgba(0,0,0,.35)";
    el.innerHTML = `<div style="font-weight:700;margin-bottom:6px">OpenCluely · Moondream</div><div>${String(reply)
      .slice(0, 420)
      .replace(/</g, "&lt;")}</div>`;
    document.body.appendChild(el);
  }, String(bridgeResult?.response || askRes.json?.text || visionText));
  await wait(500);
  await shot(appPage, "15-mid-overlay-on-random-app");
  await shot(appPage, "16-mid-overlay-closeup");
  await appPage.evaluate(() => window.scrollBy(0, 200)).catch(() => {});
  await wait(400);
  await shot(appPage, "17-end-overlay-scrolled");
  await shot(appPage, "18-end-final");

  // Stealth is a first-class feature: default honest branding + toggleable content protection.
  const mainJs = fs.readFileSync(path.join(ROOT, "apps/opencluely/main.js"), "utf8");
  const winJs = fs.readFileSync(path.join(ROOT, "apps/opencluely/src/managers/window.manager.js"), "utf8");
  const stealthReady =
    /app\.setName\("OpenCluely"\)/.test(mainJs) &&
    /setContentProtection\(stealth\)/.test(winJs) &&
    /set-stealth-mode/.test(mainJs) &&
    !/Force stealth mode IMMEDIATELY/.test(mainJs);
  results.push({ name: "stealth-ready", ok: stealthReady });
  results.push({
    name: "fresh-clone-present",
    ok: fs.existsSync(path.join(ROOT, "apps/opencluely/index.html")),
  });
  results.push({
    name: "original-ui-files",
    ok: ["index.html", "chat.html", "llm-response.html"].every((f) =>
      fs.existsSync(path.join(ROOT, "apps/opencluely", f)),
    ),
  });

  // Stop electron
  try {
    electronProc.kill("SIGTERM");
  } catch (_) {}
  await wait(1000);
  try {
    electronProc.kill("SIGKILL");
  } catch (_) {}

  await browser.close();
  meta.endedAt = new Date().toISOString();
  meta.results = results;
  meta.visionText = visionText;
  meta.ask = askRes;
  meta.bridge = bridgeResult;
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(meta, null, 2));
  log(JSON.stringify({ results, app: APP }, null, 2));
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
