/**
 * Multi-step Playwright screenshots for AI Browser + OpenCluely-style Companion.
 * Writes /opt/cursor/artifacts/browser-*.png and companion-web-*.png
 */
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:3000";
const OUT = process.env.CLYRA_VISUAL_ARTIFACTS || "/opt/cursor/artifacts";
await fs.mkdir(OUT, { recursive: true });

const fixturePort = 43127;
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"/><title>Demo Shop</title>
<style>
body{margin:0;font:16px system-ui;background:#f4f6f9;color:#172033}
header{padding:20px 8vw;background:#fff;border-bottom:1px solid #dde3eb;display:flex;gap:16px;align-items:center}
main{width:min(880px,86vw);margin:32px auto}
form{display:flex;gap:10px;margin:18px 0}
input,button,select{min-height:40px;border-radius:8px;border:1px solid #cbd5e1;padding:0 12px}
button{background:#111827;color:#fff;cursor:pointer}
.card{background:#fff;border:1px solid #dfe5ed;border-radius:10px;padding:16px;margin:12px 0}
#cookie{position:fixed;right:24px;bottom:24px;width:280px;padding:16px;background:#fff;border:1px solid #cbd5e1;box-shadow:0 14px 40px #0f172a22}
</style></head><body>
<header><strong>Demo Shop</strong><nav>Laptops · Accessories · Support</nav></header>
<main>
<h1>Refurbished laptops</h1>
<form id="f"><input id="q" placeholder="Search products"/><select id="price"><option>$700</option><option>$1000</option></select><button type="submit">Apply filters</button></form>
<div class="card"><h2>MacBook Air M1 16 GB</h2><p>$650 · Good condition</p><button id="buy">Add to cart</button></div>
<div class="card"><h2>MacBook Pro M1 16 GB</h2><p>$700 · Fair condition</p></div>
</main>
<aside id="cookie"><p>Cookie preferences</p><button id="dismiss">Dismiss cookie banner</button></aside>
<script>
document.getElementById('dismiss').onclick=()=>document.getElementById('cookie').remove();
document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.title='Filtered · '+document.getElementById('q').value};
</script></body></html>`;

const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fixtureHtml);
});
await new Promise((resolve) => fixtureServer.listen(fixturePort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shots = [];

async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);
  console.log("shot", file);
}

try {
  // AI Browser tour
  await page.goto(`${BASE}/?embedTool=browser`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(800);
  await shot("browser-01-shell");

  // Atlas omnibox is often readonly until clicked / focused for edit.
  const omnibox = page.locator('[data-browser-omnibox="true"], input[aria-label*="Address" i], input[placeholder*="Search or enter" i]').first();
  if (await omnibox.count()) {
    await omnibox.click({ force: true });
    await page.waitForTimeout(200);
    // Some builds unlock editing after click; otherwise use keyboard select-all + type.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(fixtureUrl, { delay: 8 });
    await page.keyboard.press("Enter");
  } else {
    await page.evaluate((url) => {
      const input = document.querySelector("input");
      if (!input) return;
      input.removeAttribute("readonly");
      input.focus();
      input.value = url;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, fixtureUrl);
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(1600);
  await shot("browser-02-navigated");

  // Dismiss cookie in the live page / nested frame when present.
  try {
    const dismiss = page.getByRole("button", { name: /Dismiss cookie banner/i }).first();
    if (await dismiss.count()) {
      await dismiss.click({ timeout: 3_000 });
      await page.waitForTimeout(500);
      await shot("browser-03-cookie-dismissed");
    } else {
      for (const frame of page.frames()) {
        const framed = frame.getByRole("button", { name: /Dismiss cookie banner/i });
        if (await framed.count()) {
          await framed.first().click({ timeout: 2_000 });
          await page.waitForTimeout(500);
          break;
        }
      }
      await shot("browser-03-cookie-dismissed");
    }
  } catch {
    await shot("browser-03-page-ready");
  }

  // Agent / Atlas bar if present
  const agentBits = page.locator("text=/Take control|Atlas|Agent|Ask|Resume/i").first();
  if (await agentBits.count()) {
    await shot("browser-04-agent-ui");
  } else {
    await shot("browser-04-workspace");
  }

  // Type a research-ish prompt into any large textarea/composer
  const composer = page.locator("textarea").first();
  if (await composer.count()) {
    await composer.fill("Find MacBook Air under $700 and show me where to click Apply filters");
    await page.waitForTimeout(300);
    await shot("browser-05-prompt");
    await composer.press("Enter").catch(() => undefined);
    await page.waitForTimeout(1500);
    await shot("browser-06-after-ask");
  }

  // Companion OpenCluely UI
  await page.goto(`${BASE}/?embedTool=companion`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(700);
  await shot("companion-web-01-shell");

  const guideBtn = page.locator("text=Guide").first();
  if (await guideBtn.count()) {
    await guideBtn.click();
    await page.waitForTimeout(500);
    await shot("companion-web-02-guide-pointer");
  }

  const controlBtn = page.locator("text=Control").first();
  if (await controlBtn.count()) {
    await controlBtn.click();
    await page.waitForTimeout(400);
    await shot("companion-web-03-control-bar");
  }

  const talkInput = page.locator("textarea").first();
  if (await talkInput.count()) {
    await talkInput.fill("Show me where to click on my screen");
    await page.waitForTimeout(200);
    await shot("companion-web-04-ask-typed");
    const send = page.locator("button", { hasText: "↑" }).first();
    if (await send.count()) await send.click();
    else await talkInput.press("Enter");
    await page.waitForTimeout(2000);
    await shot("companion-web-05-answer");
  }

  await fs.writeFile(
    path.join(OUT, "browser-companion-visual.json"),
    JSON.stringify({ ok: true, shots, fixtureUrl, at: new Date().toISOString() }, null, 2),
  );
  console.log("PASS visual smoke", shots.length, "screenshots");
} catch (error) {
  console.error("visual smoke failed", error);
  await shot("browser-companion-error").catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  fixtureServer.close();
}
