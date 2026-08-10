import dotenv from "dotenv";
import express, { type Express } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";

const envRoot = process.cwd();
dotenv.config({ path: path.join(envRoot, ".env") });
dotenv.config({ path: path.join(envRoot, ".env.local"), override: true });

const VIBE_SANDBOX_DIR = path.join(envRoot, "vibe-sandbox");
const SESSION_ROOT = path.join(VIBE_SANDBOX_DIR, "sessions");
const MAX_FILES = 80;
const MAX_FILE_BYTES = 512 * 1024;
const SESSION_TTL_MS = 1000 * 60 * 60 * 3;
const isAllowedOrigin = (origin: string) => {
  if (origin === "null") return true;
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
};
const SESSION_CACHE = new Map<string, { sessionId: string; url: string; files: VibeFiles }>();
const FOCUS_MODE_SCRIPT = String.raw`<script>
(() => {
  let enabled = false;
  let box = null;
  let labelNode = null;
  const selector = "a,button,input,textarea,select,[role],h1,h2,h3,nav,main,section,article,[data-testid]";

  function getLabel(el) {
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const text = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 80);
    return text ? role + ": " + text : role;
  }

  function ensureOverlay() {
    if (box && labelNode) return;
    box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;border-radius:10px;box-shadow:0 0 0 9999px rgba(37,99,235,.035),0 0 24px rgba(37,99,235,.35);transition:all .12s ease;display:none;";
    labelNode = document.createElement("div");
    labelNode.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;max-width:260px;border-radius:999px;background:#0f172a;color:white;padding:5px 9px;font:600 11px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 10px 28px rgba(15,23,42,.22);display:none;";
    document.body.append(box, labelNode);
  }

  function hideOverlay() {
    if (box) box.style.display = "none";
    if (labelNode) labelNode.style.display = "none";
  }

  function targetFromEvent(event) {
    const raw = event.target;
    if (!raw || raw === document.documentElement || raw === document.body) return null;
    return raw.closest?.(selector) || raw;
  }

  function paint(el) {
    ensureOverlay();
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      hideOverlay();
      return;
    }
    const label = getLabel(el);
    box.style.display = "block";
    box.style.left = Math.max(4, rect.left - 3) + "px";
    box.style.top = Math.max(4, rect.top - 3) + "px";
    box.style.width = Math.max(8, rect.width + 6) + "px";
    box.style.height = Math.max(8, rect.height + 6) + "px";
    labelNode.textContent = label;
    labelNode.style.display = "block";
    labelNode.style.left = Math.max(8, Math.min(window.innerWidth - 280, rect.left)) + "px";
    labelNode.style.top = Math.max(8, rect.top - 32) + "px";
  }

  function onMove(event) {
    if (!enabled) return;
    const el = targetFromEvent(event);
    if (el) paint(el);
  }

  function onClick(event) {
    if (!enabled) return;
    const el = targetFromEvent(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    window.parent?.postMessage({ type: "VIBE_FOCUS_SELECT", label: getLabel(el) }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "VIBE_FOCUS_MODE") return;
    enabled = Boolean(event.data.enabled);
    document.documentElement.style.cursor = enabled ? "crosshair" : "";
    if (!enabled) hideOverlay();
  });
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
})();
</script>`;

const TAILWIND_CDN_WARNING_GUARD = String.raw`<script data-clyra="TAILWIND_CDN_WARNING_GUARD">
(() => {
  const originalWarn = console.warn.bind(console);
  console.warn = (...args) => {
    if (String(args[0] ?? "").includes("cdn.tailwindcss.com should not be used in production")) return;
    originalWarn(...args);
  };
})();
</script>`;

type VibeFiles = Record<string, string>;

export type VibeServerHandle = {
  app: Express;
  vite: ViteDevServer;
  port: number;
  close: () => Promise<void>;
};

function sandboxPath(rawPath: string): string | null {
  if (!rawPath || rawPath.length > 220) return null;
  let p = rawPath.replace(/\\/g, "/").trim();
  p = p.replace(/^[a-zA-Z]+:\/+/, "");
  p = p.replace(/^\/+/, "");
  p = p.replace(/\u0000/g, "");
  const parts = p.split("/").filter((part) => part && part !== ".");
  if (parts[0] === "vibe-project") parts.shift();
  const clean = parts.filter((part) => part !== "..");
  if (clean.length === 0 || clean.some((part) => part.length > 96)) return null;
  return clean.join("/");
}

function pickPrimaryFile(files: VibeFiles): string | null {
  const keys = Object.keys(files);
  return (
    keys.find((k) => /src\/App\.tsx$/i.test(k)) ??
    keys.find((k) => /App\.tsx$/i.test(k)) ??
    keys.find((k) => /\.tsx$/i.test(k)) ??
    keys.find((k) => /\.jsx$/i.test(k)) ??
    keys.find((k) => /\.html?$/i.test(k)) ??
    null
  );
}

function relativeImport(fromDir: string, target: string): string {
  let rel = path.posix.relative(fromDir, target).replace(/\.(tsx|ts|jsx|js)$/i, "");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

async function emptyDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function cleanupOldSessions() {
  await fs.mkdir(SESSION_ROOT, { recursive: true });
  const now = Date.now();
  const entries = await fs.readdir(SESSION_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const full = path.join(SESSION_ROOT, e.name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && now - stat.mtimeMs > SESSION_TTL_MS) await fs.rm(full, { recursive: true, force: true });
      }),
  );
}

function injectFocusModeScript(html: string): string {
  if (html.includes("VIBE_FOCUS_MODE")) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${FOCUS_MODE_SCRIPT}\n</body>`);
  return `${html}\n${FOCUS_MODE_SCRIPT}`;
}

function suppressTailwindCdnWarning(html: string): string {
  if (!html.includes("cdn.tailwindcss.com") || html.includes("TAILWIND_CDN_WARNING_GUARD")) {
    return html;
  }
  return html.replace(/<script\s+src=["']https:\/\/cdn\.tailwindcss\.com["']><\/script>/i, `${TAILWIND_CDN_WARNING_GUARD}\n$&`);
}

async function writeSandboxFiles(sessionDir: string, rawFiles: VibeFiles): Promise<VibeFiles> {
  const sanitized: VibeFiles = {};

  for (const [rawPath, rawBody] of Object.entries(rawFiles).slice(0, MAX_FILES)) {
    const rel = sandboxPath(rawPath);
    if (!rel) continue;
    if (/(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|tsconfig\.json)$/i.test(rel)) continue;
    if (/(^|\/)\.env(\.|$)/i.test(rel)) continue;
    const body = String(rawBody ?? "");
    if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) continue;
    sanitized[rel] = body;
  }

  const hasHtml = Object.keys(sanitized).some((p) => /\.html?$/i.test(p));
  const primary = pickPrimaryFile(sanitized);

  if (!hasHtml) {
    const appRel = primary && /\.(tsx|jsx|ts|js)$/i.test(primary) ? primary : "src/App.tsx";
    if (!sanitized[appRel]) {
      sanitized[appRel] = `export default function App() {\n  return <main style={{ padding: 24, fontFamily: "system-ui" }}>No React component was generated.</main>;\n}\n`;
    }
    sanitized["src/__vibe_main.tsx"] = `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "${relativeImport("src", appRel)}";\nimport "./__vibe_reset.css";\n\nconst rootElement = document.getElementById("root");\nif (!rootElement) throw new Error("Vibe preview root element was not found.");\nconst vibeWindow = window as typeof window & { __vibePreviewRoot?: ReturnType<typeof createRoot> };\nvibeWindow.__vibePreviewRoot ??= createRoot(rootElement);\nvibeWindow.__vibePreviewRoot.render(<App />);\n`;
    sanitized["src/__vibe_reset.css"] =
      "html,body,#root{min-height:100%;margin:0}body{background:#fff;color:#0f172a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}*{box-sizing:border-box}\n";
    sanitized["index.html"] = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>Vibe Preview</title>\n  <script src="https://cdn.tailwindcss.com"></script>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/sessions/__SESSION_ID__/src/__vibe_main.tsx"></script>\n</body>\n</html>\n`;
  } else if (!sanitized["index.html"]) {
    const htmlPath = Object.keys(sanitized).find((p) => /\.html?$/i.test(p));
    if (htmlPath) sanitized["index.html"] = sanitized[htmlPath]!;
  }
  if (sanitized["index.html"]) {
    sanitized["index.html"] = injectFocusModeScript(
      suppressTailwindCdnWarning(sanitized["index.html"]!),
    );
  }

  for (const [rel, body] of Object.entries(sanitized)) {
    const resolved = path.resolve(sessionDir, rel);
    if (!resolved.startsWith(path.resolve(sessionDir) + path.sep)) continue;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, body.replaceAll("__SESSION_ID__", path.basename(sessionDir)), "utf8");
  }

  return sanitized;
}

function hashFiles(files: VibeFiles): string {
  const payload = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((key) => [key, String(files[key] ?? "")]),
  );
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function createSession(files: VibeFiles): Promise<{ sessionId: string; url: string; files: VibeFiles }> {
  const cacheKey = hashFiles(files);
  const cached = SESSION_CACHE.get(cacheKey);
  if (cached) {
    const dir = path.join(SESSION_ROOT, cached.sessionId);
    const exists = await fs.stat(dir).then((stat) => stat.isDirectory()).catch(() => false);
    if (exists) return cached;
    SESSION_CACHE.delete(cacheKey);
  }

  const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionDir = path.join(SESSION_ROOT, sessionId);
  await emptyDir(sessionDir);
  const sanitized = await writeSandboxFiles(sessionDir, files);
  if (Object.keys(sanitized).length === 0) throw new Error("No previewable files were generated.");
  const session = { sessionId, url: `/sessions/${sessionId}/index.html`, files: sanitized };
  SESSION_CACHE.set(cacheKey, session);
  return session;
}

export async function startVibeServer(port = Number(process.env.VIBE_PORT) || 5174): Promise<VibeServerHandle> {
  await fs.mkdir(SESSION_ROOT, { recursive: true });
  await cleanupOldSessions();

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (origin) res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Cross-Origin-Resource-Policy", "cross-origin");
    res.header("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "vibe-server", sandbox: VIBE_SANDBOX_DIR }));

  app.post("/api/session", async (req, res) => {
    try {
      const files = req.body?.files;
      if (!files || typeof files !== "object" || Array.isArray(files)) {
        res.status(400).json({ error: "files must be an object keyed by sandbox path" });
        return;
      }
      const session = await createSession(files as VibeFiles);
      res.json({ sessionId: session.sessionId, url: `http://localhost:${port}${session.url}`, files: Object.keys(session.files) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/test-preview", async (req, res) => {
    let browser;
    try {
      const files = req.body?.files as VibeFiles | undefined;
      const testPrompt = String(req.body?.testPrompt ?? "");
      const headfulMode = Boolean(req.body?.headfulMode);
      let url = String(req.body?.url ?? "");
      if (files && typeof files === "object") {
        const session = await createSession(files);
        url = `http://localhost:${port}${session.url}`;
      }
      if (!url.startsWith(`http://localhost:${port}/sessions/`)) {
        res.status(400).json({ error: "Only Vibe sandbox session URLs can be tested" });
        return;
      }

      browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const consoleMessages: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (msg) => {
        if (["error", "warning"].includes(msg.type())) consoleMessages.push(`${msg.type()}: ${msg.text()}`);
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(700);
      if (headfulMode) {
        await page.mouse.move(180, 160, { steps: 12 });
        await page.waitForTimeout(160);
        await page.mouse.move(760, 430, { steps: 18 });
        await page.mouse.down();
        await page.waitForTimeout(120);
        await page.mouse.up();
        await page.mouse.move(420, 610, { steps: 16 });
      }

      const visibleText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const screenshot = await page.screenshot({ fullPage: true });
      const blank = visibleText.trim().length === 0;
      let calculatorTest: { success: boolean; result?: string; error?: string; test: string } | null = null;
      let platformerTest: { success: boolean; details?: string; error?: string; test: string } | null = null;
      if (testPrompt.toLowerCase().includes("calculator")) {
        try {
          await page.getByRole("button", { name: "1" }).click({ timeout: 5000 });
          await page.getByRole("button", { name: "+" }).click({ timeout: 5000 });
          await page.getByRole("button", { name: "2" }).click({ timeout: 5000 });
          await page.getByRole("button", { name: "=" }).click({ timeout: 5000 });
          await page.waitForTimeout(300);
          const result = await page.locator('input, output, [data-result], .display, .result, [aria-live="polite"]').first().evaluate((el) => (el as HTMLInputElement).value || el.textContent || "");
          calculatorTest = { success: /(^|[^0-9])3([^0-9]|$)/.test(result), result, test: "1 + 2 = 3" };
        } catch (error) {
          calculatorTest = { success: false, error: error instanceof Error ? error.message : String(error), test: "1 + 2 = 3" };
        }
      }
      if (/(platformer|game|2d)/i.test(testPrompt)) {
        try {
          const canvasCount = await page.locator("canvas").count();
          await page.keyboard.press("ArrowRight");
          await page.keyboard.press("Space");
          await page.waitForTimeout(450);
          const hasGameText = /score|coin|jump|level|player|platform/i.test(visibleText);
          platformerTest = {
            success: canvasCount > 0 || hasGameText,
            details: `canvas=${canvasCount}, gameText=${hasGameText}`,
            test: "render game surface and accept keyboard input",
          };
        } catch (error) {
          platformerTest = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            test: "render game surface and accept keyboard input",
          };
        }
      }

      res.json({
        success:
          !blank &&
          pageErrors.length === 0 &&
          (calculatorTest ? calculatorTest.success : true) &&
          (platformerTest ? platformerTest.success : true),
        url,
        title: await page.title(),
        mode: headfulMode ? "headful-replay" : "headless",
        blank,
        visibleText: visibleText.slice(0, 1000),
        consoleMessages,
        pageErrors,
        calculatorTest,
        platformerTest,
        screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await browser?.close();
    }
  });

  const vibeHmrPort = Number(process.env.VIBE_HMR_PORT) || 24679;
  const vite = await createViteServer({
    configFile: false,
    root: VIBE_SANDBOX_DIR,
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: {
        host: "localhost",
        port: vibeHmrPort,
        clientPort: vibeHmrPort,
      },
      fs: { strict: true, allow: [VIBE_SANDBOX_DIR, path.join(envRoot, "node_modules")] },
    },
    resolve: { alias: { "@": path.join(VIBE_SANDBOX_DIR, "src") } },
    optimizeDeps: { entries: [] },
    clearScreen: false,
  });

  app.use(vite.middlewares);
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Vibe sandbox server running on http://localhost:${port}`);
    console.log(`Vibe sandbox directory: ${VIBE_SANDBOX_DIR}`);
  });

  return {
    app,
    vite,
    port,
    close: async () => {
      await vite.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("vibe-server")) {
  startVibeServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
