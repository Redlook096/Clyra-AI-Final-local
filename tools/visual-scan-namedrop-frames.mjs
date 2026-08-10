/**
 * Capture NameDrop liquid-wave visual-scan frames via Playwright.
 * Loads the real overlay.html with a synthetic desktop backdrop and seeks progress.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OVERLAY = path.join(ROOT, "scripts/opencluely-bridge/visual-scan/overlay.html");
const OUT =
  process.env.SHOT_DIR ||
  (fs.existsSync("/opt/cursor/artifacts")
    ? "/opt/cursor/artifacts/namedrop-wave"
    : path.join(ROOT, "qa-screenshots/namedrop-wave"));
const SCREENSHOTS =
  process.env.SCREENSHOT_DIR ||
  (fs.existsSync("/opt/cursor/artifacts/screenshots")
    ? "/opt/cursor/artifacts/screenshots"
    : path.join(ROOT, "qa-screenshots/namedrop-wave"));

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

async function main() {
  if (!fs.existsSync(OVERLAY)) {
    throw new Error(`overlay missing: ${OVERLAY}`);
  }

  const W = 1440;
  const H = 900;

  // Serve overlay + allow file reads via simple static server from bridge folder.
  const bridgeDir = path.dirname(OVERLAY);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = path.join(bridgeDir, urlPath === "/" ? "overlay.html" : urlPath);
    if (!filePath.startsWith(bridgeDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const ext = path.extname(filePath);
    const type =
      ext === ".html"
        ? "text/html"
        : ext === ".js"
          ? "text/javascript"
          : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(fs.readFileSync(filePath));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });

  // Build a synthetic multi-window desktop inside the page, then run the scan.
  const scene = await page.evaluate(async ({ W, H }) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    // Wallpaper
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#1a2332");
    grad.addColorStop(0.5, "#243447");
    grad.addColorStop(1, "#15202b");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // Soft light
    const vg = g.createRadialGradient(W * 0.7, H * 0.2, 40, W * 0.7, H * 0.2, 520);
    vg.addColorStop(0, "rgba(120,170,220,0.22)");
    vg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    const windows = [
      { x: 60, y: 50, w: 620, h: 420, title: "Chrome — Docs", color: "#eceff3" },
      { x: 520, y: 140, w: 700, h: 520, title: "VS Code — project", color: "#1e1e1e" },
      { x: 80, y: 500, w: 380, h: 280, title: "Terminal", color: "#0d1117" },
      { x: 980, y: 40, w: 380, h: 260, title: "Spotify", color: "#121212" },
    ];
    for (const win of windows) {
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(win.x + 6, win.y + 8, win.w, win.h);
      g.fillStyle = win.color;
      roundRect(g, win.x, win.y, win.w, win.h, 12);
      g.fill();
      // Title bar
      g.fillStyle = win.color === "#eceff3" ? "#dfe3e8" : "#2a2a2a";
      roundRect(g, win.x, win.y, win.w, 34, 12);
      g.fill();
      g.fillStyle = win.color === "#eceff3" ? "#dfe3e8" : "#2a2a2a";
      g.fillRect(win.x, win.y + 16, win.w, 18);
      g.fillStyle = win.color === "#eceff3" ? "#222" : "#ddd";
      g.font = "13px ui-sans-serif, system-ui, sans-serif";
      g.fillText(win.title, win.x + 14, win.y + 22);
      // Fake content lines
      g.fillStyle = win.color === "#eceff3" ? "#333" : "#9cdcfe";
      g.font = "12px ui-monospace, Menlo, monospace";
      for (let i = 0; i < 10; i++) {
        const line = `${i % 3 === 0 ? "const" : "  "} item_${i} = compute(${i * 17})`;
        g.fillText(line, win.x + 18, win.y + 58 + i * 18);
      }
    }
    // Dock / taskbar
    g.fillStyle = "rgba(20,24,32,0.85)";
    g.fillRect(0, H - 48, W, 48);
    g.fillStyle = "rgba(255,255,255,0.7)";
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.arc(80 + i * 48, H - 24, 12, 0, Math.PI * 2);
      g.fill();
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    const backdropDataUrl = c.toDataURL("image/png");
    const elements = windows.map((win, i) => ({
      id: `w${i}`,
      app: win.title,
      role: "window",
      frame: { x: win.x, y: win.y, w: win.w, h: win.h },
      importance: 1,
      hierarchyDepth: 0,
      activationRadius: Math.hypot(
        Math.min(Math.max(W / 2, win.x), win.x + win.w) - W / 2,
        Math.min(Math.max(H / 2, win.y), win.y + win.h) - H / 2,
      ),
      cornerRadius: 12,
    }));

    const scene = {
      width: W,
      height: H,
      scale: 1,
      durationMs: 2000,
      origin: { x: W / 2, y: H / 2 },
      maxRadius: Math.hypot(W / 2, H / 2) * 1.08,
      elements,
      reason: "namedrop-preview",
      backdropDataUrl,
      hasBackdrop: true,
      liquidWarp: true,
      seekOnly: true,
      seekProgress: 0,
    };

    await window.__runVisualScan(scene);
    return { ok: true, elements: elements.length };
  }, { W, H });

  console.log("scene ready", scene);

  // Ease-out travels fast early — denser sampling in the first half.
  const frames = [0.02, 0.06, 0.1, 0.16, 0.24, 0.34, 0.48, 0.68, 0.92];
  for (let i = 0; i < frames.length; i++) {
    const p = frames[i];
    await page.evaluate((progress) => {
      window.__seekVisualScan?.(progress);
    }, p);
    await page.waitForTimeout(50);
    const name = `namedrop-${String(i + 1).padStart(2, "0")}-p${Math.round(p * 100)}`;
    const dest = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: dest, type: "png" });
    fs.copyFileSync(dest, path.join(SCREENSHOTS, `${name}.png`));
    console.log("shot", name);
  }

  await browser.close();
  server.close();
  console.log("done", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
