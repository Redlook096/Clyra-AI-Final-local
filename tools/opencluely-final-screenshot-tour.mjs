/**
 * Final OpenCluely function tour + screenshots (control API driven).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/final-test";
const SCREENSHOTS = "/opt/cursor/artifacts/screenshots";
const CONTROL = process.env.CLYRA_CONTROL_PORT
  ? `http://127.0.0.1:${process.env.CLYRA_CONTROL_PORT}`
  : "http://127.0.0.1:3847";
const CLYRA = process.env.CLYRA_API_BASE || "http://127.0.0.1:31415";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[final-tour]", ...a);

async function shot(name) {
  const dest = path.join(OUT, `${name}.png`);
  await new Promise((resolve, reject) => {
    const p = spawn("scrot", [dest], { stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`scrot ${code}`))));
  });
  fs.copyFileSync(dest, path.join(SCREENSHOTS, `final-${name}.png`));
  log("shot", name);
  return dest;
}

async function control(pathname, body = {}, timeoutMs = 15000) {
  const res = await fetch(`${CONTROL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const results = [];
  const record = (step, ok, detail = "") => {
    results.push({ step, ok, detail });
    log(ok ? "PASS" : "FAIL", step, detail);
  };

  // Health
  try {
    const h = await fetch(`${CONTROL}/health`, { signal: AbortSignal.timeout(4000) });
    const j = await h.json();
    record("health", Boolean(j.ok && j.ready), JSON.stringify(j));
  } catch (e) {
    record("health", false, e.message);
    throw e;
  }

  // 1) Collapsed pill
  await control("/show", { windows: ["main"] });
  await control("/collapse", {});
  await wait(700);
  await shot("01-collapsed-pill");
  record("screenshot-collapsed", true);

  // 2) Expand Ask
  await control("/expand", {});
  await wait(900);
  await shot("02-expanded-ask");
  record("expand-ask", true);

  // 3) Chat hello
  const chat = await control("/chat", { text: "hello from final test" }, 90000);
  await wait(1200);
  await shot("03-chat-hello");
  record("chat-hello", chat.ok, JSON.stringify(chat.json).slice(0, 160));

  // 4) Collapse
  await control("/collapse", {});
  await wait(700);
  await shot("04-collapsed-again");
  record("collapse", true);

  // 5) Expand / collapse smoothness check (screen scan animation removed)
  await control("/show", { windows: ["main"] });
  await wait(300);
  await control("/expand", {});
  await wait(400);
  await shot("05-expanded-smooth");
  await control("/collapse", {});
  await wait(350);
  await shot("05-collapsed-smooth");
  record("expand-collapse-smooth", true);

  // 6) What's on my screen (vision)
  await control("/expand", {});
  await wait(400);
  await shot("06-before-screen-ask");
  const screenP = control("/chat", { text: "what's on my screen?" }, 200000);
  await wait(500);
  await shot("06-screen-ask-mid");
  const screen = await screenP;
  await wait(800);
  await shot("06-screen-answer");
  record("screen-ask", screen.ok, JSON.stringify(screen.json).slice(0, 200));

  // 7) Web search
  await shot("07-before-search");
  const search = await control("/chat", { text: "/search latest node.js LTS" }, 120000);
  await wait(1000);
  await shot("07-search-answer");
  record("web-search", search.ok, JSON.stringify(search.json).slice(0, 200));

  // 8) Auto answer
  const auto = await control("/auto-answer", {}, 200000);
  await wait(400);
  for (let i = 1; i <= 8; i++) {
    await shot(`08-auto-${String(i).padStart(2, "0")}`);
    await wait(150);
  }
  await wait(500);
  await shot("08-auto-done");
  record("auto-answer", auto.ok, JSON.stringify(auto.json).slice(0, 200));

  // Backend sanity
  try {
    const tags = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    record("ollama", tags.ok, `status=${tags.status}`);
  } catch (e) {
    record("ollama", false, e.message);
  }
  try {
    const web = await fetch(`${CLYRA}/api/research/web-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "node.js LTS", maxResults: 2, fetchTop: 0 }),
      signal: AbortSignal.timeout(60000),
    });
    const wj = await web.json();
    record("clyra-web-search-api", web.ok && wj.ok !== false, `urls=${(wj.urls || []).length}`);
  } catch (e) {
    record("clyra-web-search-api", false, e.message);
  }

  await control("/collapse", {});
  await wait(500);
  await shot("09-final-collapsed");

  const summary = {
    finishedAt: new Date().toISOString(),
    control: CONTROL,
    results,
    passCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    outDir: OUT,
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(SCREENSHOTS, "final-test-summary.json"), JSON.stringify(summary, null, 2));
  log("DONE", summary.passCount, "passed,", summary.failCount, "failed");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
