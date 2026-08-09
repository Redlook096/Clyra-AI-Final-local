/**
 * Exhaustive OpenCluely feature / launcher / tool smoke test.
 * Assumes Clyra (:31415), OpenCluely control (:3847), Ollama (:11434) are up.
 */
import { chromium } from "playwright";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/opencluely-full";
const YT = process.env.OPENCLUELY_YT || "https://youtu.be/fhs7voB2eJQ?si=XQs0CCiUoch0Xosv";
const CLYRA = process.env.CLYRA_API_BASE || "http://127.0.0.1:31415";
const OC = process.env.CLYRA_CONTROL_BASE || "http://127.0.0.1:3847";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const VISION = process.env.OPENCLUELY_VISION_MODEL || "gemma3:4b";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync("/opt/cursor/artifacts/screenshots", { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (...a) => console.log("[oc-full]", ...a);

function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "").slice(0, 400) });
  log(ok ? "PASS" : "FAIL", name, detail ? `— ${String(detail).slice(0, 160)}` : "");
}

async function jsonFetch(url, opts = {}, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return { status: res.status, body, ok: res.ok };
  } finally {
    clearTimeout(t);
  }
}

async function oc(method, pathname, body) {
  return jsonFetch(`${OC}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function shotDisplay(name) {
  const dest = path.join(OUT, `${name}.png`);
  try {
    execFileSync("import", ["-window", "root", dest], { timeout: 8000, stdio: "ignore" });
    fs.copyFileSync(dest, path.join("/opt/cursor/artifacts/screenshots", `oc-full-${name}.png`));
    return dest;
  } catch (error) {
    log("shot failed", name, error.message);
    return null;
  }
}

async function main() {
  // ── 0) Launchers / health ──────────────────────────────────────────
  const healths = await Promise.all([
    jsonFetch(`${CLYRA}/`, {}, 5000).catch(() => ({ status: 0 })),
    oc("GET", "/health"),
    oc("GET", "/stealth"),
    jsonFetch(`${OLLAMA}/api/tags`, {}, 5000),
  ]);
  record("launcher:clyra-api", healths[0].status > 0 && healths[0].status < 500, `status=${healths[0].status}`);
  record("launcher:oc-health", healths[1].body?.ok === true, JSON.stringify(healths[1].body));
  record("launcher:oc-stealth-get", healths[2].body?.ok === true, JSON.stringify(healths[2].body));
  const models = healths[3].body?.models || [];
  const hasVision = models.some((m) => String(m.name || "").includes(VISION.split(":")[0]));
  record("launcher:ollama-vision-model", hasVision, models.map((m) => m.name).join(",") || "none");

  // Scripts exist
  for (const script of [
    "scripts/clone-opencluely.sh",
    "scripts/start-opencluely-electron.sh",
    "scripts/opencluely-bridge/macos-input.py",
  ]) {
    record(`launcher:file:${path.basename(script)}`, fs.existsSync(path.join(ROOT, script)));
  }

  // ── 1) Show / hide / toggle ────────────────────────────────────────
  let r = await oc("POST", "/show", { windows: ["main"] });
  record("api:show-main", r.body?.ok === true, JSON.stringify(r.body));
  await wait(400);
  shotDisplay("01-show-main");

  r = await oc("POST", "/hide");
  record("api:hide", r.body?.ok === true, JSON.stringify(r.body));
  await wait(300);
  shotDisplay("02-hide");

  r = await oc("POST", "/toggle");
  record("api:toggle-on", r.body?.ok === true, JSON.stringify(r.body));
  await wait(300);
  r = await oc("POST", "/show", { windows: ["main"] });
  record("api:show-after-toggle", r.body?.ok === true);

  // ── 2) Stealth on/off ──────────────────────────────────────────────
  r = await oc("POST", "/stealth", { enabled: true });
  record("api:stealth-on", r.body?.ok === true && r.body?.stealth === true, JSON.stringify(r.body));
  await wait(250);
  shotDisplay("03-stealth-on");
  r = await oc("POST", "/stealth", { enabled: false });
  record("api:stealth-off", r.body?.ok === true && r.body?.stealth === false, JSON.stringify(r.body));
  await wait(250);

  // ── 3) Skill switch ────────────────────────────────────────────────
  r = await oc("POST", "/skill", { skill: "general" });
  record("api:skill-general", r.body?.ok === true, JSON.stringify(r.body));

  // ── 4) Open YouTube as the "screen content" ────────────────────────
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-gpu", `--window-size=1280,800`, "--window-position=80,120"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  log("opening YouTube", YT);
  await page.goto(YT, { waitUntil: "domcontentloaded", timeout: 90000 }).catch((e) => log("yt nav", e.message));
  await wait(3500);
  // Dismiss consent if present
  try {
    const consent = page.locator('button:has-text("Accept all"), button:has-text("Reject all"), button:has-text("I agree")').first();
    if (await consent.isVisible({ timeout: 2500 })) await consent.click({ timeout: 3000 });
  } catch {
    /* ignore */
  }
  await wait(2000);
  shotDisplay("04-youtube-open");
  const ytTitle = await page.title().catch(() => "");
  record("feature:youtube-open", /youtube|youtu/i.test(page.url()) || /youtube/i.test(ytTitle), `url=${page.url()} title=${ytTitle}`);

  // Bring OpenCluely above the page
  await oc("POST", "/show", { windows: ["main"] });
  await wait(400);
  shotDisplay("05-bar-over-youtube");

  // ── 5) Chat (plain) ────────────────────────────────────────────────
  r = await oc("POST", "/chat", { text: "Say hi in one short sentence." });
  record("api:chat-plain", r.body?.ok === true, JSON.stringify(r.body));
  await wait(8000);
  shotDisplay("06-after-chat");

  // ── 6) Screen / vision question ────────────────────────────────────
  r = await oc("POST", "/chat", { text: "What is on my screen right now? Name the site and video if visible." });
  record("api:chat-screen-vision", r.body?.ok === true && /screenshot|vision|chat/i.test(String(r.body?.action || "ok")), JSON.stringify(r.body));
  await wait(25000);
  shotDisplay("07-after-vision");

  // Direct Ollama vision on a frame
  const framePath = path.join(OUT, "yt-frame.png");
  await page.screenshot({ path: framePath }).catch(() => {});
  if (fs.existsSync(framePath)) {
    const b64 = fs.readFileSync(framePath).toString("base64");
    const vision = await jsonFetch(
      `${OLLAMA}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VISION,
          prompt: "In one sentence: what website/app is this and what is the main content?",
          images: [b64],
          stream: false,
        }),
      },
      120000,
    );
    const vtext = String(vision.body?.response || "");
    record("tool:ollama-vision-direct", vision.status === 200 && vtext.length > 8, vtext.slice(0, 220));
    fs.writeFileSync(path.join(OUT, "vision-direct.json"), JSON.stringify({ status: vision.status, text: vtext }, null, 2));
  } else {
    record("tool:ollama-vision-direct", false, "no frame");
  }

  // ── 7) Auto Answer ─────────────────────────────────────────────────
  r = await oc("POST", "/auto-answer", { text: "Answer anything useful about the screen." });
  record("api:auto-answer", r.body?.ok === true, JSON.stringify(r.body));
  await wait(20000);
  shotDisplay("08-after-auto-answer");

  // ── 8) Screenshot OCR path ─────────────────────────────────────────
  r = await oc("POST", "/screenshot");
  record("api:screenshot", r.body?.ok === true, JSON.stringify(r.body));
  await wait(15000);
  shotDisplay("09-after-screenshot");

  // ── 9) Web research / search-style ask ─────────────────────────────
  r = await oc("POST", "/chat", { text: "Search the web: what year was YouTube founded? Give a short factual answer with sources if possible." });
  record("api:chat-web-research", r.body?.ok === true, JSON.stringify(r.body));
  await wait(45000);
  shotDisplay("10-after-research");

  // Clyra research tool directly
  const research = await jsonFetch(
    `${CLYRA}/api/research/web-search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "YouTube founding year", maxResults: 3 }),
    },
    60000,
  ).catch((e) => ({ status: 0, body: { error: e.message } }));
  record(
    "tool:clyra-web-search",
    research.status < 500 && (research.body?.results || research.body?.sources || research.body?.ok || research.body?.analysisPrompt),
    JSON.stringify(research.body).slice(0, 300),
  );

  // Companion ask
  const ask = await jsonFetch(
    `${CLYRA}/api/companion/ask`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "In one word, say ready." }),
    },
    60000,
  );
  record("tool:clyra-companion-ask", ask.status < 500 && Boolean(ask.body?.text || ask.body?.reply), JSON.stringify(ask.body).slice(0, 220));

  // ── 10) Point guide ────────────────────────────────────────────────
  r = await oc("POST", "/control/point", { text: "Where is the play button?" });
  record("api:control-point", r.body?.ok === true, JSON.stringify(r.body));
  await wait(6000);
  shotDisplay("11-after-point");

  // ── 11) Take Control (short safe task) ─────────────────────────────
  r = await oc("POST", "/control/start", {
    task: "Move the mouse to the center of the screen, wait briefly, then stop. Do not close any windows. Do not type destructive commands.",
  });
  record("api:control-start", r.body?.ok === true, JSON.stringify(r.body));
  await wait(18000);
  shotDisplay("12-during-control");
  r = await oc("POST", "/control/stop");
  record("api:control-stop", r.body?.ok === true, JSON.stringify(r.body));
  await wait(1000);
  shotDisplay("13-after-control-stop");

  // xdotool smoke (Linux desktop driver)
  try {
    execFileSync("xdotool", ["mousemove", "640", "400"], { timeout: 3000 });
    record("tool:xdotool-move", true);
  } catch (error) {
    record("tool:xdotool-move", false, error.message);
  }

  // ── 12) Chat drawer expand via show chat ───────────────────────────
  r = await oc("POST", "/show", { windows: ["chat"] });
  record("api:show-chat-drawer", r.body?.ok === true, JSON.stringify(r.body));
  await wait(900);
  shotDisplay("14-chat-drawer-open");
  r = await oc("POST", "/show", { windows: ["main"] });
  record("api:collapse-to-main", r.body?.ok === true);
  await wait(700);
  shotDisplay("15-collapsed-main");

  // ── 13) Hide settings endpoint ─────────────────────────────────────
  r = await oc("POST", "/hide-settings");
  record("api:hide-settings", r.body?.ok === true, JSON.stringify(r.body));

  await browser.close().catch(() => {});

  // Summary
  const failed = results.filter((x) => !x.ok);
  const summary = {
    at: new Date().toISOString(),
    visionModel: VISION,
    youtube: YT,
    total: results.length,
    passed: results.filter((x) => x.ok).length,
    failed: failed.length,
    results,
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n======== OPENCLUELY FULL TEST SUMMARY ========");
  console.log(`passed ${summary.passed}/${summary.total}`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const f of failed) console.log(" -", f.name, f.detail);
  }
  console.log("wrote", path.join(OUT, "summary.json"));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
