/**
 * Voice call + Companion ("hello" / what's on screen) start/mid/end screenshots.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/voice-call";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[voice-call]", ...args);

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
  await page.screenshot({ path: path.join(SCREENSHOTS, `voice-${name}.png`), fullPage: false });
  log("shot", dest);
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
  const page = await context.newPage();
  const results = [];

  // ---- Companion (OpenCluely) hello / what's on screen ----
  await page.goto(`${BASE}/?embedTool=companion`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1200);
  await forceWorkspace(page, "companion");
  await wait(1200);
  await take(page, "01-companion-start-hello");
  const helloVisible = await page.getByText(/hello|Hi|screen|Companion|Guide/i).first().isVisible().catch(() => false);
  results.push({ name: "companion-hello", ok: helloVisible });

  const guide = page.getByRole("button", { name: /^Guide$/i }).or(page.getByText(/^Guide$/i));
  if (await guide.count()) {
    await guide.first().click().catch(() => {});
    await wait(600);
  }
  await take(page, "02-companion-mid-guide");

  const ask = page.getByPlaceholder(/Ask|screen|what's|what is/i).or(page.locator("textarea").first());
  if (await ask.count()) {
    await ask.first().fill("What's on my screen right now? Say hello and describe it.");
    await wait(300);
    await take(page, "03-companion-ask-filled");
    const send = page.getByRole("button", { name: /Send|Ask/i }).or(page.locator('button[type="submit"]')).first();
    if (await send.count()) await send.click().catch(() => {});
    await wait(4000);
  }
  await take(page, "04-companion-mid-answer");
  await take(page, "05-companion-end");

  // ---- Voice call overlay from Chat ----
  await page.goto(`${BASE}/?embedTool=chat`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await wait(1200);
  await forceWorkspace(page, "chat");
  await wait(1200);
  await take(page, "06-voice-start-chat");

  const startCall = page.getByRole("button", { name: /Start voice call/i });
  let callOpened = false;
  if (await startCall.count()) {
    await startCall.first().click();
    await wait(2000);
    callOpened =
      (await page.getByRole("button", { name: /End voice call/i }).isVisible().catch(() => false)) ||
      (await page.getByText(/Listening|Connecting|Speaking|Muted/i).first().isVisible().catch(() => false));
    await take(page, "07-voice-mid-connecting");
    await wait(2500);
    await take(page, "08-voice-mid-active");

    // Try type message into call if dock exists
    const typeBtn = page.getByRole("button", { name: /Type a message/i });
    if (await typeBtn.count()) {
      await typeBtn.first().click().catch(() => {});
      await wait(500);
    }
    const callInput = page.locator("textarea").filter({ hasText: "" }).or(page.locator('.clyra-voice-call-overlay textarea, textarea[placeholder*="Type" i]')).first();
    if (await callInput.count() && await callInput.evaluate((el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT").catch(() => false)) {
      await callInput.fill("Hello — what's on my screen?");
      await wait(300);
      await take(page, "09-voice-mid-typed");
      const sendType = page.getByRole("button", { name: /Send/i }).first();
      if (await sendType.count()) await sendType.click().catch(() => {});
      await wait(2000);
      await take(page, "09b-voice-mid-sent");
    } else {
      await take(page, "09-voice-mid-typed");
    }

    const end = page.getByRole("button", { name: /End voice call/i });
    if (await end.count()) {
      await end.first().click();
      await wait(1000);
    }
  } else {
    log("Start voice call button missing");
  }
  await take(page, "10-voice-end");
  results.push({ name: "voice-call-open", ok: callOpened });

  // Backend voice session smoke
  try {
    const session = await fetch(`${BASE}/voice/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await session.json().catch(() => ({}));
    results.push({
      name: "voice-session-api",
      ok: session.ok && Boolean(payload?.sessionId || payload?.ok || payload?.id),
      detail: `status=${session.status}`,
    });
    if (payload?.sessionId || payload?.id) {
      await fetch(`${BASE}/voice/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: payload.sessionId || payload.id }),
      }).catch(() => {});
    }
  } catch (err) {
    results.push({ name: "voice-session-api", ok: false, detail: String(err) });
  }

  const summary = { results, callOpened, helloVisible };
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(summary, null, 2));
  log(JSON.stringify(summary, null, 2));
  await browser.close();
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
