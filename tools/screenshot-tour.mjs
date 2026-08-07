/**
 * Capture every major Clyra screen / menu / mid-action state for the release tour.
 */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = process.env.SHOT_DIR || "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const shots = [];

async function shot(page, name, note = "") {
  const file = path.join(OUT, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push({ name, note, file });
  console.log(`✓ ${name}${note ? ` — ${note}` : ""}`);
  return file;
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function forceWorkspace(page, id) {
  await page.evaluate((workspace) => {
    const rootEl = document.querySelector("#root");
    if (!rootEl) return false;
    const key = Object.keys(rootEl).find(
      (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"),
    );
    if (!key) return false;
    let fiber = rootEl[key];
    if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
    const seen = new Set();
    function walk(f, depth = 0) {
      if (!f || depth > 100 || seen.has(f)) return false;
      seen.add(f);
      let h = f.memoizedState;
      let i = 0;
      while (h && i < 80) {
        const val = h.memoizedState;
        if (
          (val === "chat" || val === "vibe" || val === "clip" || val === "browser" || val === "study" || val === "companion") &&
          h.queue?.dispatch
        ) {
          h.queue.dispatch(workspace);
          return true;
        }
        h = h.next;
        i++;
      }
      return walk(f.child, depth + 1) || walk(f.sibling, depth + 1);
    }
    return walk(fiber);
  }, id);
  await wait(700);
}

async function openTaskView(page) {
  await page.evaluate(() => {
    const rootEl = document.querySelector("#root");
    const key = Object.keys(rootEl).find(
      (k) => k.startsWith("__reactContainer") || k.startsWith("__reactFiber"),
    );
    let fiber = rootEl[key];
    if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
    const seen = new Set();
    function walk(f, depth = 0) {
      if (!f || depth > 100 || seen.has(f)) return false;
      seen.add(f);
      let count = 0;
      let t = f.memoizedState;
      while (t && count < 200) {
        count++;
        t = t.next;
      }
      if (count > 80) {
        let h = f.memoizedState;
        let i = 0;
        while (h && i < 150) {
          const next = h.next;
          if (
            typeof h.memoizedState === "boolean" &&
            next &&
            typeof next.memoizedState === "boolean" &&
            next.next &&
            Array.isArray(next.next.memoizedState) &&
            next.next.memoizedState[0] === "chat"
          ) {
            next.queue.dispatch(true);
            return true;
          }
          h = h.next;
          i++;
        }
      }
      return walk(f.child, depth + 1) || walk(f.sibling, depth + 1);
    }
    return walk(fiber);
  });
  await wait(900);
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
});
const page = await context.newPage();
page.setDefaultTimeout(12000);

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await wait(1200);
  await shot(page, "01-chat-home", "Chat welcome / home");

  // Sidebar open
  const sidebarBtn = page.getByRole("button", { name: /Open sidebar|Close sidebar/i }).first();
  if (await sidebarBtn.count()) {
    await sidebarBtn.click().catch(() => {});
    await wait(500);
    await shot(page, "02-chat-sidebar", "Chat with sidebar");
  }

  // Quick commands / slash palette
  const quick = page.getByRole("button", { name: /Open quick commands/i }).first();
  if (await quick.count()) {
    await quick.click().catch(() => {});
    await wait(400);
    await shot(page, "03-quick-commands", "Quick commands / slash menu");
    await page.keyboard.press("Escape");
    await wait(300);
  }

  // Type in composer
  const composer = page.getByPlaceholder(/Ask Clyra|anything/i).first();
  if (await composer.count()) {
    await composer.click();
    await composer.fill("Summarise the benefits of a calm product UI");
    await wait(300);
    await shot(page, "04-chat-composer-filled", "Composer with draft message");
  }

  // Settings
  const settings = page.getByRole("button", { name: /^Settings$/i }).first();
  if (await settings.count()) {
    await settings.click().catch(() => {});
    await wait(600);
    await shot(page, "05-settings", "Settings screen / sheet");
    await page.keyboard.press("Escape");
    await wait(300);
  }

  // Search modal
  const search = page.getByRole("button", { name: /Search/i }).first();
  if (await search.count()) {
    await search.click().catch(() => {});
    await wait(500);
    await shot(page, "06-search-modal", "Chat search modal");
    await page.keyboard.press("Escape");
    await wait(300);
  }

  // App launcher (Ctrl+K)
  await page.keyboard.press("Control+k");
  await wait(600);
  await shot(page, "07-app-launcher", "App launcher (Ctrl+K)");
  await page.keyboard.press("Escape");
  await wait(400);

  // --- Vibe Coder ---
  const vibeTab = page.getByRole("tab", { name: /Vibe Coder/i }).first();
  if (await vibeTab.count()) {
    await vibeTab.click();
  } else {
    await forceWorkspace(page, "vibe");
  }
  await wait(1000);
  await shot(page, "08-vibe-coder-idle", "Vibe Coder idle / empty or projects");

  // Collapse sidebar if present
  const collapse = page.getByRole("button", { name: /Collapse sidebar/i }).first();
  if (await collapse.count()) {
    await collapse.click().catch(() => {});
    await wait(400);
    await shot(page, "09-vibe-sidebar-collapsed", "Vibe Coder sidebar collapsed");
  }

  // Mid-action: type a build prompt and send if possible
  const vibeComposer = page.getByPlaceholder(/Describe what to build|Ask me anything|Plan, build/i).first();
  if (await vibeComposer.count()) {
    await vibeComposer.click();
    await vibeComposer.fill("Create a polished calculator with clear buttons and keyboard support");
    await wait(300);
    await shot(page, "10-vibe-composer-ready", "Vibe Coder prompt ready to send");
    const send = page.getByRole("button", { name: /^Send$/i }).first();
    if (await send.count() && (await send.isEnabled().catch(() => false))) {
      await send.click().catch(() => {});
      await wait(2500);
      await shot(page, "11-vibe-mid-action", "Vibe Coder mid-action / thinking");
      await wait(3500);
      await shot(page, "12-vibe-mid-action-2", "Vibe Coder mid-action continued");
    }
  } else {
    // No project — create one
    const newProj = page.getByRole("button", { name: /New project/i }).first();
    if (await newProj.count()) {
      await newProj.click().catch(() => {});
      await wait(500);
      await shot(page, "10-vibe-new-project", "Vibe Coder new project dialog");
      const nameInput = page.getByTestId("clyra-code-new-project-name").or(page.getByPlaceholder(/Project name/i)).first();
      if (await nameInput.count()) {
        await nameInput.fill("Calculator demo");
        await page.keyboard.press("Enter");
        await wait(900);
        await shot(page, "11-vibe-project-created", "Vibe Coder after creating project");
        const c2 = page.getByPlaceholder(/Describe what to build/i).first();
        if (await c2.count()) {
          await c2.fill("Create a polished calculator with clear buttons");
          await wait(200);
          const send2 = page.getByRole("button", { name: /^Send$/i }).first();
          if (await send2.count()) {
            await send2.click().catch(() => {});
            await wait(2500);
            await shot(page, "12-vibe-mid-action", "Vibe Coder mid-action / thinking");
            await wait(4000);
            await shot(page, "13-vibe-mid-action-2", "Vibe Coder mid-action continued");
          }
        }
      }
    }
  }

  // Right panel tabs
  const browserTabInVibe = page.getByRole("button", { name: /^Browser$/i }).first();
  if (await browserTabInVibe.count()) {
    await browserTabInVibe.click().catch(() => {});
    await wait(400);
    await shot(page, "14-vibe-preview-panel", "Vibe Coder preview / browser panel");
  }
  const summaryTab = page.getByRole("button", { name: /^Summary$/i }).first();
  if (await summaryTab.count()) {
    await summaryTab.click().catch(() => {});
    await wait(400);
    await shot(page, "15-vibe-summary-panel", "Vibe Coder summary panel");
  }

  // --- Clip ---
  const clipTab = page.getByRole("tab", { name: /^Clip$/i }).first();
  if (await clipTab.count()) {
    await clipTab.click();
  } else {
    await forceWorkspace(page, "clip");
  }
  await wait(1000);
  await shot(page, "16-clipper-home", "AI Clipper home");

  const clipInput = page.getByPlaceholder(/YouTube|URL|paste/i).first();
  if (await clipInput.count()) {
    await clipInput.click();
    await clipInput.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await wait(300);
    await shot(page, "17-clipper-url-entered", "Clipper with URL entered");
  }

  // --- AI Browser ---
  await forceWorkspace(page, "browser");
  await wait(1200);
  await shot(page, "18-ai-browser", "AI Browser workspace");

  const ask = page.getByRole("button", { name: /Ask Clyra/i }).first();
  if (await ask.count()) {
    await ask.click().catch(() => {});
    await wait(600);
    await shot(page, "19-ai-browser-ask-panel", "AI Browser Ask Clyra panel");
    const taskBox = page.getByPlaceholder(/Describe a task/i).first();
    if (await taskBox.count()) {
      await taskBox.fill("Open google.com and search for Clyra AI product design");
      await wait(300);
      await shot(page, "20-ai-browser-task-ready", "AI Browser task ready");
      const run = page.getByRole("button", { name: /Run browser task/i }).first();
      if (await run.count() && (await run.isEnabled().catch(() => false))) {
        await run.click().catch(() => {});
        await wait(2500);
        await shot(page, "21-ai-browser-mid-action", "AI Browser mid-action");
        await wait(4000);
        await shot(page, "22-ai-browser-mid-action-2", "AI Browser mid-action continued");
      }
    }
  }

  const newTab = page.getByRole("button", { name: /New tab/i }).first();
  if (await newTab.count()) {
    await newTab.click().catch(() => {});
    await wait(800);
    await shot(page, "23-ai-browser-new-tab", "AI Browser new tab / start page attempt");
  }

  const browserMenu = page.getByRole("button", { name: /Browser menu/i }).first();
  if (await browserMenu.count()) {
    await browserMenu.click().catch(() => {});
    await wait(400);
    await shot(page, "24-ai-browser-menu", "AI Browser overflow menu");
    await page.keyboard.press("Escape");
  }

  // --- Study Pal ---
  await forceWorkspace(page, "study");
  await wait(1200);
  await shot(page, "25-study-pal-idle", "Study Pal idle canvas");

  const studyComposer = page.getByPlaceholder(/Ask the Brain|study/i).first();
  if (await studyComposer.count()) {
    await studyComposer.fill("Explain photosynthesis in three clear points");
    await wait(300);
    await shot(page, "26-study-pal-prompt", "Study Pal prompt ready");
    await page.keyboard.press("Enter");
    await wait(2500);
    await shot(page, "27-study-pal-mid-action", "Study Pal mid-action");
    await wait(3500);
    await shot(page, "28-study-pal-mid-action-2", "Study Pal mid-action continued");
  }

  // --- Companion ---
  await forceWorkspace(page, "companion");
  await wait(1000);
  await shot(page, "29-companion", "Screen Companion workspace");

  // --- Chat again + Task View ---
  await forceWorkspace(page, "chat");
  await wait(800);
  await openTaskView(page);
  await wait(800);
  await shot(page, "30-task-view", "Task View overview");
  await page.keyboard.press("Escape");
  await wait(700);
  await shot(page, "31-after-task-view", "After closing Task View");

  // Temporary chat toggle if present
  const temp = page.getByRole("button", { name: /Temporary Chat/i }).first();
  if (await temp.count()) {
    await temp.click().catch(() => {});
    await wait(500);
    await shot(page, "32-temporary-chat", "Temporary chat toggle feedback");
  }

  // Account / rewards / notifications if present in header
  for (const label of ["Notifications", "Rewards", "Account", "Clips", "Projects"]) {
    const btn = page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first();
    if (await btn.count()) {
      await btn.click().catch(() => {});
      await wait(450);
      await shot(page, `33-menu-${label.toLowerCase()}`, `${label} menu / panel`);
      await page.keyboard.press("Escape");
      await wait(250);
    }
  }

  console.log(JSON.stringify({ ok: true, count: shots.length, shots }, null, 2));
} catch (error) {
  console.error("Tour failed:", error);
  await shot(page, "zz-error", String(error?.message || error)).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(shots, null, 2));
  await browser.close();
}
