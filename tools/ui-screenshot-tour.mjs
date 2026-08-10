/**
 * Capture real UI screenshots:
 * - Voice call via Playwright against Clyra (:31415) with fake mic/camera
 * - OpenCluely all buttons via CDP (:9230) page screenshots
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOT_DIR || path.join(process.env.HOME || "/tmp", ".cursor/artifacts/ui-tour-20260810");
const SCREENSHOTS = path.join(process.env.HOME || "/tmp", ".cursor/artifacts/screenshots");
const CONTROL = "http://127.0.0.1:3847";
const CLYRA = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OC_CDP = process.env.OC_CDP || "http://127.0.0.1:9230";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[ui-tour]", ...a);

async function shot(page, name, opts = {}) {
  const dest = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false, ...opts });
  fs.copyFileSync(dest, path.join(SCREENSHOTS, `${name}.png`));
  log("shot", name);
  return dest;
}

async function control(pathname, body = {}, timeoutMs = 15000) {
  const res = await fetch(`${CONTROL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, json: { raw: text } };
  }
}

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
  await wait(900);
}

async function tourVoice() {
  log("=== voice ===");
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1440, height: 920 },
  });
  // Grant media without prompts
  await context.grantPermissions(["microphone", "camera"], { origin: CLYRA });
  const page = await context.newPage();
  await page.goto(`${CLYRA}/?embedTool=chat`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await wait(1500);
  await forceWorkspace(page, "chat");
  await wait(1200);
  await shot(page, "voice-01-chat-ready");

  // Ensure empty composer
  const ta = page.locator("#chat-container textarea, textarea").first();
  if (await ta.count()) {
    await ta.fill("");
    await wait(200);
  }
  await shot(page, "voice-02-before-call");

  const start = page.getByRole("button", { name: /Start voice call/i });
  if (await start.count()) {
    await start.first().click();
  } else {
    await page.locator('button[aria-label="Start voice call"]').first().click({ timeout: 5000 });
  }
  await wait(2000);
  await shot(page, "voice-03-connecting");
  await wait(2500);
  await shot(page, "voice-04-listening");

  // Mute
  const mute = page.locator('button[aria-label*="Mute" i], button[aria-label*="Unmute" i], button[aria-label*="microphone" i]').first();
  if (await mute.count()) {
    await mute.click().catch(() => {});
    await wait(500);
    await shot(page, "voice-05-muted");
    await mute.click().catch(() => {});
    await wait(300);
  }

  // Messages sheet
  for (const label of [/Messages/i, /Conversation/i, /Transcript/i]) {
    const btn = page.getByRole("button", { name: label });
    if (await btn.count()) {
      await btn.first().click().catch(() => {});
      await wait(700);
      await shot(page, "voice-06-messages");
      break;
    }
  }

  // Type
  const typeBtn = page.getByRole("button", { name: /Type a message|Type/i });
  if (await typeBtn.count()) {
    await typeBtn.first().click().catch(() => {});
    await wait(500);
    const input = page.locator('input[placeholder*="Type" i], textarea[placeholder*="message" i]').first();
    if (await input.count()) await input.fill("Hello from voice screenshot tour");
    await shot(page, "voice-07-type");
  }

  // Camera
  const cam = page.getByRole("button", { name: /camera/i });
  if (await cam.count()) {
    await cam.first().click().catch(() => {});
    await wait(1200);
    await shot(page, "voice-08-camera");
  }

  await shot(page, "voice-09-controls");

  const end = page.getByRole("button", { name: /End voice call/i });
  if (await end.count()) {
    await end.first().click().catch(() => {});
    await wait(800);
  }
  await shot(page, "voice-10-ended");
  await browser.close();
}

async function ocPage(browser) {
  const context = browser.contexts()[0];
  const pages = context.pages();
  // Prefer the OpenCluely index / bar page
  let page =
    pages.find((p) => /opencluely|index\.html|file:|localhost|127\.0\.0\.1/i.test(p.url()) && !/devtools/i.test(p.url())) ||
    pages.find((p) => p.url() && !p.url().startsWith("devtools:")) ||
    pages[0];
  // Enumerate for logs
  for (const p of pages) log("oc-page", p.url());
  return page;
}

async function tourOpenCluely() {
  log("=== opencluely CDP ===");
  const browser = await chromium.connectOverCDP(OC_CDP, { timeout: 60000 });
  const page = await ocPage(browser);
  if (!page) throw new Error("No OpenCluely page");

  // Ensure visible + collapsed
  await control("/show", { windows: ["main"] });
  await control("/collapse", {});
  await wait(500);
  // Force reveal via DOM
  await page.evaluate(() => {
    document.documentElement.classList.remove("oc-stealth");
    document.documentElement.classList.add("oc-force-light");
    const shell = document.getElementById("ocShell");
    if (shell) {
      shell.style.opacity = "1";
      shell.classList.remove("is-boot-squish", "is-fading-out");
    }
  }).catch(() => {});
  await wait(300);
  await shot(page, "oc-01-collapsed", { omitBackground: false });

  // Click Ask in page
  const ask = page.locator("#ocAskBtn");
  if (await ask.count()) {
    await ask.click();
    await wait(400);
  } else {
    await control("/expand", {});
    await wait(400);
  }
  await shot(page, "oc-02-ask");

  // Type + send via DOM
  await page.evaluate(() => {
    const input = document.getElementById("barChatInput");
    if (input) {
      input.value = "hello from screenshot tour";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }).catch(() => {});
  await wait(200);
  await shot(page, "oc-03-ask-typed");
  const send = page.locator("#barChatSend");
  if (await send.count()) await send.click().catch(() => {});
  else await control("/chat", { text: "hello from screenshot tour" }, 8000).catch(() => {});
  await wait(900);
  await shot(page, "oc-04-ask-thinking-or-reply");
  await wait(2500);
  await shot(page, "oc-05-ask-reply");

  // Collapse via close
  const close = page.locator("#ocCloseBtn");
  if (await close.count()) await close.click().catch(() => {});
  else await control("/collapse", {});
  await wait(400);
  await shot(page, "oc-06-collapsed-again");

  // Auto Answer button
  const auto = page.locator("#ocAutoBtn");
  if (await auto.count()) {
    await auto.click();
    await wait(1000);
    await shot(page, "oc-07-auto-answer");
    await wait(2000);
    await shot(page, "oc-08-auto-mid");
  }

  // Collapse
  if (await close.count()) await close.click().catch(() => {});
  await wait(400);

  // Stealth toggle
  const stealth = page.locator("#ocStealthWrap, #ocStealthSwitch").first();
  if (await stealth.count()) {
    await stealth.click();
    await wait(300);
    await shot(page, "oc-09-stealth-on");
    await stealth.click();
    await wait(300);
    await shot(page, "oc-10-stealth-off");
  } else {
    await control("/stealth", { enabled: true });
    await wait(300);
    await shot(page, "oc-09-stealth-on");
    await control("/stealth", { enabled: false });
    await wait(300);
    await shot(page, "oc-10-stealth-off");
  }

  // Take Control button
  const controlBtn = page.locator("#ocControlBtn");
  if (await controlBtn.count()) {
    await controlBtn.click();
    await wait(500);
    await shot(page, "oc-11-take-control-prompt");
    await page.evaluate(() => {
      const el = document.getElementById("ocInlineControlInput");
      if (el) {
        el.value = "Open Notes and type hello";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }).catch(() => {});
    await wait(300);
    await shot(page, "oc-12-take-control-typed");
    // Escape / close without actually running destructive control long
    if (await close.count()) await close.click().catch(() => {});
    await control("/control/stop", {}).catch(() => {});
    await wait(400);
  }

  // Ask again for screen question UI
  if (await ask.count()) await ask.click();
  else await control("/expand", {});
  await wait(400);
  await page.evaluate(() => {
    const input = document.getElementById("barChatInput");
    if (input) {
      input.value = "what's on my screen?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }).catch(() => {});
  await shot(page, "oc-13-screen-ask-typed");
  if (await send.count()) await send.click().catch(() => {});
  await wait(1200);
  await shot(page, "oc-14-screen-ask-thinking");
  await wait(3000);
  await shot(page, "oc-15-screen-ask-result");

  // Final collapsed
  if (await close.count()) await close.click().catch(() => {});
  await wait(400);
  await shot(page, "oc-16-final");
}

async function main() {
  const errors = [];
  try {
    await tourVoice();
  } catch (e) {
    errors.push({ tour: "voice", error: String(e?.message || e) });
    log("voice fail", e);
  }
  try {
    await tourOpenCluely();
  } catch (e) {
    errors.push({ tour: "opencluely", error: String(e?.message || e) });
    log("oc fail", e);
  }
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).sort();
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ files, errors, at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ ok: errors.length === 0, count: files.length, out: OUT, files, errors }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
