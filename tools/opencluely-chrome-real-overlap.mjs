/**
 * Focused real-overlap test: Google Chrome + original OpenCluely Electron UI.
 * No fake HTML cards. Desktop screenshots only.
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/opencluely-chrome";
const DISPLAY = process.env.DISPLAY || ":1";
const CONTROL = "http://127.0.0.1:3847";

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync("/opt/cursor/artifacts/screenshots", { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[oc-real]", ...a);
const sh = (cmd) =>
  execSync(cmd, { encoding: "utf8", env: { ...process.env, DISPLAY }, stdio: ["ignore", "pipe", "pipe"] });

function shot(name) {
  const dest = path.join(OUT, `${name}.png`);
  sh(`import -window root "${dest}"`);
  fs.copyFileSync(dest, path.join("/opt/cursor/artifacts/screenshots", `oc-real-${name}.png`));
  log("shot", name, fs.statSync(dest).size);
  return dest;
}

async function api(method, route, body) {
  const res = await fetch(`${CONTROL}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function listWins() {
  const tree = sh("xwininfo -root -tree");
  const out = [];
  for (const line of tree.split("\n")) {
    const m = line.match(/(0x[0-9a-f]+)\s+"([^"]*)":\s+\("([^"]*)"\s+"([^"]*)"\)\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)/i);
    if (!m) continue;
    out.push({
      id: m[1],
      title: m[2],
      cls: m[3],
      cls2: m[4],
      w: Number(m[5]),
      h: Number(m[6]),
      x: Number(m[7]),
      y: Number(m[8]),
    });
  }
  return out;
}

function pick(wins, pred) {
  return wins.filter(pred).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
}

function place(win, x, y, w, h) {
  if (!win) return;
  try {
    if (w && h) sh(`xdotool windowsize ${win.id} ${Math.round(w)} ${Math.round(h)}`);
    sh(`xdotool windowmove ${win.id} ${Math.round(x)} ${Math.round(y)}`);
    sh(`xdotool windowactivate ${win.id}`);
    sh(`xdotool windowraise ${win.id}`);
  } catch (e) {
    log("place fail", win.title, e.message);
  }
}

async function waitHealth(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const h = await api("GET", "/health");
      if (h.json?.ok && h.json?.ready) return h.json;
    } catch (_) {}
    await wait(700);
  }
  throw new Error("control not ready");
}

async function main() {
  const results = [];
  // Start electron
  const elLog = fs.openSync(path.join(OUT, "electron.log"), "w");
  const electron = spawn("bash", [path.join(ROOT, "scripts/start-opencluely-electron.sh")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISPLAY,
      CLYRA_CONTROL_PORT: "3847",
      CLYRA_API_BASE: "http://127.0.0.1:31415",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      OPENCLUELY_VISION_MODEL: "llava-phi3",
    },
    stdio: ["ignore", elLog, elLog],
  });
  log("electron", electron.pid);

  // Start Chrome
  const profile = "/tmp/oc-chrome-profile-real";
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(
    "google-chrome",
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--window-size=1280,860",
      "--window-position=80,60",
      "https://example.com/",
    ],
    { env: { ...process.env, DISPLAY }, stdio: "ignore", detached: true },
  );
  log("chrome", chrome.pid);
  await wait(5500);
  shot("01-chrome-example");

  const health = await waitHealth();
  log("health", health);
  results.push({ name: "control", ok: true });
  await api("POST", "/skill", { skill: "general" });
  await api("POST", "/hide-settings");
  await api("POST", "/show");
  await wait(1200);

  let wins = listWins();
  log(
    "wins",
    wins
      .filter((w) => /opencluely|chrome|chromium/i.test(`${w.title} ${w.cls} ${w.cls2}`))
      .map((w) => `${w.title} ${w.w}x${w.h}@${w.x},${w.y}`),
  );

  const chromeWin = pick(wins, (w) => /google-chrome|Chromium|Chrome/i.test(w.cls2) && w.w > 400);
  const cmd = pick(wins, (w) => w.title === "OpenCluely" && w.h > 20 && w.h < 80 && /opencluely/i.test(w.cls));
  const chat = pick(wins, (w) => w.title === "Chat" && /opencluely/i.test(w.cls));
  const settings = pick(wins, (w) => w.title === "Settings" && /opencluely/i.test(w.cls));
  // hide settings offscreen
  if (settings) place(settings, -2000, -2000, 300, 300);
  if (chromeWin) place(chromeWin, 40, 40, 1400, 900);
  if (cmd) place(cmd, 120, 70, 520, 40);
  if (chat) place(chat, 980, 120, 460, 640);
  await wait(700);
  shot("02-overlap-chrome-plus-opencluely");
  results.push({ name: "overlap-visible-windows", ok: Boolean(cmd && chat && chromeWin), detail: { cmd, chat, chrome: chromeWin } });

  // What's on screen via real screenshot path
  shot("03-before-whats-on-screen");
  const s1 = await api("POST", "/screenshot");
  log("screenshot", s1);
  await wait(16000);
  wins = listWins();
  const llm = pick(wins, (w) => /AI Response/i.test(w.title) || (w.title === "OpenCluely" && w.h > 100 && w.w > 300));
  if (llm) place(llm, 280, 140, 680, 420);
  if (cmd) place(cmd, 120, 70);
  if (chat) place(chat, 980, 120, 460, 640);
  await wait(500);
  shot("04-mid-whats-on-screen-answer");
  shot("05-end-whats-on-screen");
  results.push({ name: "whats-on-screen", ok: s1.json?.ok === true });

  // Chat ask
  const c1 = await api("POST", "/chat", { text: "What's on my screen right now? Name the page title." });
  log("chat", c1);
  await wait(12000);
  shot("06-mid-chat-whats-on-screen");
  shot("07-end-chat-whats-on-screen");
  results.push({ name: "chat-whats-on-screen", ok: c1.json?.ok === true });

  // Navigate to Wikipedia
  if (chromeWin) {
    sh(`xdotool windowactivate ${chromeWin.id}`);
    await wait(200);
    sh("xdotool key ctrl+l");
    await wait(150);
    sh("xdotool type --delay 5 'https://en.wikipedia.org/wiki/MacBook'");
    sh("xdotool key Return");
  }
  await wait(5000);
  if (cmd) place(cmd, 120, 70);
  if (chat) place(chat, 980, 120, 460, 640);
  shot("08-overlap-wikipedia");
  const s2 = await api("POST", "/screenshot");
  await wait(16000);
  wins = listWins();
  const llm2 = pick(wins, (w) => /AI Response/i.test(w.title) || (w.title === "OpenCluely" && w.h > 100));
  if (llm2) place(llm2, 280, 140, 680, 420);
  shot("09-mid-wikipedia-answer");
  shot("10-end-wikipedia-answer");
  results.push({ name: "wikipedia", ok: s2.json?.ok === true });

  // Other asks
  for (const [i, text] of [
    [11, "Summarise the main heading in one short sentence."],
    [13, "Is this a coding interview problem or a normal webpage?"],
  ]) {
    shot(`${i}-before`);
    const r = await api("POST", "/chat", { text });
    await wait(10000);
    shot(`${i + 1}-after`);
    results.push({ name: `ask-${i}`, ok: r.json?.ok === true, detail: text });
  }

  shot("90-final-overlap");
  fs.writeFileSync(path.join(OUT, "result-real.json"), JSON.stringify({ results }, null, 2));
  log(JSON.stringify({ results }, null, 2));
  try {
    process.kill(-chrome.pid, "SIGTERM");
  } catch (_) {
    try {
      chrome.kill();
    } catch (_) {}
  }
  if (!results.every((r) => r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
