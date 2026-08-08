/**
 * Exhaustive Clyra tool suite: unit/API smokes + embed UI screenshots.
 * Writes /opt/cursor/artifacts/all-tools/summary.json and screenshots.
 */
import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/all-tools";
const SHOTS = "/opt/cursor/artifacts/screenshots";
const CLYRA = process.env.CLYRA_API_BASE || "http://127.0.0.1:31415";
const OC = process.env.CLYRA_CONTROL_BASE || "http://127.0.0.1:3847";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const YT = process.env.OPENCLUELY_YT || "https://youtu.be/fhs7voB2eJQ?si=XQs0CCiUoch0Xosv";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (...a) => console.log("[all-tools]", ...a);

function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "").slice(0, 500) });
  log(ok ? "PASS" : "FAIL", name, detail ? `— ${String(detail).slice(0, 180)}` : "");
}

async function jsonFetch(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return { status: res.status, body, ok: res.ok, text };
  } finally {
    clearTimeout(t);
  }
}

function runNpm(script, timeoutMs = 180000, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("npm", ["run", script, "--silent"], {
      cwd: ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        CLYRA_URL: CLYRA,
        CLYRA_API_BASE: CLYRA,
        CLYRA_SERVICE_URL: CLYRA,
        SHOT_DIR: OUT,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, out: out.slice(-4000), ms: Date.now() - started });
    });
  });
}

async function shotPage(page, name) {
  const dest = path.join(OUT, `${name}.png`);
  const pub = path.join(SHOTS, `all-tools-${name}.png`);
  try {
    await page.screenshot({ path: dest, fullPage: false });
    fs.copyFileSync(dest, pub);
    return dest;
  } catch (error) {
    log("shot failed", name, error.message);
    return null;
  }
}

async function main() {
  // ── Health ─────────────────────────────────────────────────────────
  const health = await jsonFetch(`${CLYRA}/`, {}, 8000).catch(() => ({ status: 0 }));
  record("health:clyra", health.status > 0 && health.status < 500, `status=${health.status}`);

  const ocHealth = await jsonFetch(`${OC}/health`, {}, 5000).catch(() => ({ body: null }));
  record("health:opencluely", ocHealth.body?.ok === true, JSON.stringify(ocHealth.body));

  const ollama = await jsonFetch(`${OLLAMA}/api/tags`, {}, 5000).catch(() => ({ body: null }));
  record("health:ollama", Array.isArray(ollama.body?.models), (ollama.body?.models || []).map((m) => m.name).join(","));

  // ── Unit / package test scripts ────────────────────────────────────
  const unitScripts = [
    ["unit:voice", "test:voice", 120000],
    ["unit:creator", "test:creator", 120000],
    ["unit:fake-text-timeline", "test:fake-text:timeline", 120000],
    ["unit:clipper", "test:clipper", 180000],
    ["unit:clip-zoom", "test:clip-zoom", 120000],
    ["unit:clipper-publishing", "test:clipper-publishing", 120000],
    ["unit:licensed-footage", "test:licensed-footage", 120000],
    ["unit:study-brain", "test:study-brain", 120000],
    ["unit:companion", "test:companion", 120000],
    ["unit:vibe-runtime", "test:vibe-runtime", 180000],
    ["unit:agent-controller", "test:agent-controller", 120000],
  ];

  // Run unit tests sequentially to avoid resource contention, but keep going on failures.
  for (const [name, script, timeoutMs] of unitScripts) {
    log("running", script);
    const r = await runNpm(script, timeoutMs);
    record(name, r.code === 0, `exit=${r.code} ${r.ms}ms ${r.out.slice(-280)}`);
    fs.writeFileSync(path.join(OUT, `${name}.log`), r.out || "(empty)");
  }

  // Playwright fake-text suites (can be heavy)
  for (const [name, script, timeoutMs] of [
    ["e2e:fake-text-visual", "test:fake-text:visual", 300000],
    ["e2e:fake-text-render", "test:fake-text:render", 300000],
  ]) {
    log("running", script);
    const r = await runNpm(script, timeoutMs);
    record(name, r.code === 0, `exit=${r.code} ${r.ms}ms ${r.out.slice(-280)}`);
    fs.writeFileSync(path.join(OUT, `${name}.log`), r.out || "(empty)");
  }

  // Browser e2e (Playwright)
  log("running test:browser");
  {
    const r = await runNpm("test:browser", 300000);
    record("e2e:browser", r.code === 0, `exit=${r.code} ${r.ms}ms ${r.out.slice(-280)}`);
    fs.writeFileSync(path.join(OUT, "e2e-browser.log"), r.out || "(empty)");
  }

  // Companion electron smoke (isolated port so it won't collide with desktop:dev)
  log("running test:companion:electron");
  {
    const r = await runNpm("test:companion:electron", 240000, {
      CLYRA_COMPANION_SMOKE_PORT: "31515",
      CLYRA_DESKTOP_PORT: "31515",
    });
    record("e2e:companion-electron", r.code === 0, `exit=${r.code} ${r.ms}ms ${r.out.slice(-280)}`);
    fs.writeFileSync(path.join(OUT, "e2e-companion-electron.log"), r.out || "(empty)");
  }

  // ── API tool probes ────────────────────────────────────────────────
  const research = await jsonFetch(
    `${CLYRA}/api/research/web-search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "YouTube founding year", maxResults: 3 }),
    },
    90000,
  ).catch((e) => ({ status: 0, body: { error: e.message } }));
  record(
    "api:web-search",
    research.status < 500 && (research.body?.ok || research.body?.urls || research.body?.results),
    JSON.stringify(research.body).slice(0, 300),
  );

  const companionAsk = await jsonFetch(
    `${CLYRA}/api/companion/ask`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "In one short sentence, what is on screen?",
        visionSummary: "A desktop with Chrome open on YouTube.",
      }),
    },
    60000,
  );
  record("api:companion-ask", companionAsk.status < 500 && Boolean(companionAsk.body?.text || companionAsk.body?.ok), JSON.stringify(companionAsk.body).slice(0, 240));

  const studyAsk = await jsonFetch(
    `${CLYRA}/api/study/ask`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What is photosynthesis in one sentence?",
        context: [
          {
            title: "Biology basics",
            body: "Photosynthesis is the process by which green plants use sunlight to synthesize foods from carbon dioxide and water.",
          },
        ],
      }),
    },
    90000,
  ).catch((e) => ({ status: 0, body: { error: e.message } }));
  record(
    "api:study-ask",
    studyAsk.status < 500 && Boolean(studyAsk.body?.ok || studyAsk.body?.answer),
    JSON.stringify(studyAsk.body).slice(0, 240),
  );

  const creatorGen = await jsonFetch(
    `${CLYRA}/api/creator/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "fake_text_story",
        prompt: "Two friends texting about weekend plans.",
        count: 4,
        tone: "funny",
      }),
    },
    120000,
  ).catch((e) => ({ status: 0, body: { error: e.message } }));
  record(
    "api:creator-fake-text",
    creatorGen.status < 500 && creatorGen.body?.ok === true && Array.isArray(creatorGen.body?.data?.messages),
    JSON.stringify(creatorGen.body).slice(0, 300),
  );

  const vibeHealth = await jsonFetch(`${CLYRA}/api/vibe/projects`, {}, 15000).catch(() => ({ status: 0, body: {} }));
  record(
    "api:vibe-projects",
    vibeHealth.status > 0 &&
      vibeHealth.status < 500 &&
      !String(vibeHealth.body?.raw || "").includes("<!doctype html>"),
    JSON.stringify(vibeHealth.body || vibeHealth).slice(0, 240),
  );

  const clipperHealth = await jsonFetch(`${CLYRA}/api/clipper/autoclip/status`, {}, 15000).catch(() => ({
    status: 0,
    body: {},
  }));
  record(
    "api:clipper-status",
    clipperHealth.status > 0 &&
      clipperHealth.status < 500 &&
      !String(clipperHealth.body?.raw || "").includes("<!doctype html>"),
    JSON.stringify(clipperHealth.body).slice(0, 240),
  );

  const voiceConfig = await jsonFetch(`${CLYRA}/api/voice/config`, {}, 10000).catch(() => ({ status: 0, body: {} }));
  record("api:voice-config", voiceConfig.status > 0 && voiceConfig.status < 500, JSON.stringify(voiceConfig.body).slice(0, 240));

  // OpenCluely quick path with YouTube context already validated earlier — keep light
  const ocShow = await jsonFetch(`${OC}/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windows: ["main"] }),
  }, 8000).catch(() => ({ body: null }));
  record("api:opencluely-show", ocShow.body?.ok === true, JSON.stringify(ocShow.body));

  // ── UI embed tour + screenshots ────────────────────────────────────
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1440,900", "--window-position=40,40"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const embeds = [
    ["ui-chat", `${CLYRA}/`],
    ["ui-vibe", `${CLYRA}/?embedTool=vibe`],
    ["ui-clipper", `${CLYRA}/?embedTool=clip`],
    ["ui-fake-text", `${CLYRA}/?embedTool=fake-text`],
    ["ui-would-rather", `${CLYRA}/?embedTool=would-rather`],
    ["ui-study", `${CLYRA}/?embedTool=study`],
    ["ui-browser", `${CLYRA}/?embedTool=browser`],
    ["ui-companion", `${CLYRA}/?embedTool=companion`],
  ];

  for (const [name, url] of embeds) {
    log("ui", name, url);
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await wait(3500);
      // dismiss obvious modals
      try {
        const btn = page.locator('button:has-text("Got it"), button:has-text("Continue"), button:has-text("Skip"), button:has-text("Close")').first();
        if (await btn.isVisible({ timeout: 1500 })) await btn.click({ timeout: 2000 });
      } catch {
        /* ignore */
      }
      await wait(800);
      await shotPage(page, name);
      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const looksBroken =
        /something went wrong|uncaught|cannot find module|failed to fetch/i.test(bodyText) ||
        (resp && resp.status() >= 500);
      record(`ui:${name}`, !looksBroken && Boolean(title || bodyText), `status=${resp?.status()} title=${title} chars=${bodyText.length}`);
    } catch (error) {
      record(`ui:${name}`, false, error.message);
      await shotPage(page, `${name}-error`).catch(() => {});
    }
  }

  // Open YouTube in a tab for clipper/research context screenshot
  try {
    await page.goto(YT, { waitUntil: "domcontentloaded", timeout: 90000 });
    await wait(3000);
    try {
      const consent = page.locator('button:has-text("Accept all"), button:has-text("Reject all"), button:has-text("I agree")').first();
      if (await consent.isVisible({ timeout: 2000 })) await consent.click({ timeout: 3000 });
    } catch {
      /* ignore */
    }
    await wait(1500);
    await shotPage(page, "ui-youtube-context");
    record("ui:youtube-context", /youtube|youtu/i.test(page.url()), page.url());
  } catch (error) {
    record("ui:youtube-context", false, error.message);
  }

  await browser.close().catch(() => {});

  const failed = results.filter((x) => !x.ok);
  const summary = {
    at: new Date().toISOString(),
    clyra: CLYRA,
    youtube: YT,
    total: results.length,
    passed: results.filter((x) => x.ok).length,
    failed: failed.length,
    results,
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n======== ALL TOOLS SUMMARY ========");
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
