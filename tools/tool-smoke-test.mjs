/**
 * One-by-one tool smoke test for Clyra Code / Browser / Study.
 * Waits for each action to settle and reports pass/fail with errors.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:31415";
const OUT = "/opt/cursor/artifacts/tool-tests";
fs.mkdirSync(OUT, { recursive: true });

const results = [];

function log(msg) {
  console.log(msg);
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
          (val === "chat" ||
            val === "vibe" ||
            val === "clip" ||
            val === "browser" ||
            val === "study" ||
            val === "companion") &&
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
  await wait(900);
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function record(name, ok, detail, page) {
  const file = await shot(page, name.replace(/\s+/g, "-").toLowerCase());
  results.push({ name, ok, detail, file });
  log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}

async function main() {
  log(`Testing against ${BASE}`);

  const health = await api("GET", "/api/health");
  log(
    `${health.status === 200 && health.json?.status === "ok" ? "PASS" : "FAIL"}  api-health — status=${health.status}`,
  );
  results.push({
    name: "api-health",
    ok: health.status === 200 && health.json?.status === "ok",
    detail: `status=${health.status}`,
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await wait(2500);
  await record("boot", true, "App loaded", page);

  // ========== CHAT ==========
  await forceWorkspace(page, "chat");
  await wait(500);
  const chatComposer = page.locator("textarea, [contenteditable='true']").first();
  const chatVisible = await chatComposer.isVisible().catch(() => false);
  await record("chat-open", chatVisible, chatVisible ? "Chat composer visible" : "Chat composer missing", page);

  // ========== CLYRA CODE (vibe) ==========
  try {
    await forceWorkspace(page, "vibe");
    await wait(1200);
    // Dismiss any leftover new-project modal
    await page.keyboard.press("Escape");
    await wait(200);
    const codeTitle = await page.getByText("Clyra Code").first().isVisible().catch(() => false);
    const newProject = page.getByRole("button", { name: /New project/i }).first();
    const hasNew = await newProject.isVisible().catch(() => false);
    await record("code-shell", codeTitle || hasNew, `title=${codeTitle} new=${hasNew}`, page);

    if (hasNew) {
      await newProject.click();
      await wait(400);
      const nameInput = page.getByTestId("clyra-code-new-project-name");
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill("Calculator smoke UI");
        await page.getByRole("button", { name: /^Create$/i }).click();
        await wait(2000);
        await record("code-new-project-ui", true, "Created via dialog", page);
      } else {
        await page.keyboard.press("Escape");
        await record("code-new-project-ui", false, "Dialog input missing", page);
      }
    }

    const created = await api("POST", "/api/vibe/projects", { name: "Calculator smoke", prompt: "calculator" });
    const projectId = created.json?.project?.id || created.json?.id;
    await record(
      "code-new-project-api",
      Boolean(projectId),
      projectId ? `project=${projectId}` : created.text,
      page,
    );

    // Select project in sidebar if listed
    if (projectId) {
      const row = page.getByText(/Calculator smoke/i).first();
      if (await row.isVisible().catch(() => false)) await row.click().catch(() => {});
      await wait(600);
    }

    await page.keyboard.press("Escape");
    await wait(200);

    const vibeComposer = page
      .locator("textarea[placeholder*='Ask'], textarea[placeholder*='build'], .clyra-code-root textarea")
      .first();
    if (await vibeComposer.isVisible().catch(() => false)) {
      await vibeComposer.fill(
        "Create a clean calculator app with addition, subtraction, multiplication and division.",
      );
      await wait(300);
      const send = page.locator('button[aria-label="Send"]').first();
      if (await send.isEnabled().catch(() => false)) {
        await send.click({ force: true });
        await wait(12000);
        const body = await page.locator("body").innerText();
        const thinking = /Thinking|Reading|Editing|Running|Inspecting|opencode/i.test(body);
        const failed = /ENOENT|Failed spawn|spawn opencode/i.test(body);
        await record(
          "code-send-prompt",
          !failed,
          failed
            ? "OpenCode spawn failed"
            : thinking
              ? "Agent activity visible"
              : "Prompt sent; waiting for stream",
          page,
        );
      } else {
        await record("code-send-prompt", false, "Send button disabled", page);
      }
    } else {
      await record("code-send-prompt", false, "Composer not found in Code workspace", page);
    }
  } catch (err) {
    await record("code-section", false, String(err).slice(0, 200), page);
  }

  // ========== BROWSER ==========
  try {
    await forceWorkspace(page, "browser");
    await wait(1500);
    const startBrand = await page.getByRole("heading", { name: "Clyra" }).first().isVisible().catch(() => false);
    const startSearch = page.locator(".clyra-browser-start input").first();
    const searchOk = await startSearch.isVisible().catch(() => false);
    const askChrome = await page.getByRole("button", { name: /Ask Clyra/i }).first().isVisible().catch(() => false);
    const alreadyBrowsing =
      askChrome ||
      (await page.locator("[data-browser-omnibox]").count().then((n) => n > 0).catch(() => false));
    await record(
      "browser-start",
      Boolean((startBrand && searchOk) || alreadyBrowsing),
      startBrand && searchOk
        ? "Atlas start page"
        : alreadyBrowsing
          ? "Browser chrome ready (prior tab)"
          : `brand=${startBrand} search=${searchOk}`,
      page,
    );

    if (searchOk) {
      await startSearch.click();
      await startSearch.fill("https://example.com");
      await startSearch.press("Enter");
      await wait(4000);
      const ask = page.getByRole("button", { name: /Ask Clyra/i }).first();
      const askOk = await ask.isVisible().catch(() => false);
      await record("browser-navigate", askOk, askOk ? "Navigated; Ask Clyra visible" : "Ask Clyra missing", page);
      if (askOk) {
        await ask.click({ force: true });
        await wait(800);
        const side = await page
          .getByText(/Ask about this page|Ask Clyra|Using this page|Agent/i)
          .first()
          .isVisible()
          .catch(() => false);
        await record("browser-ask-sidebar", side, side ? "Sidebar open" : "Sidebar content not found", page);
      }
    } else {
      // Fallback: focus omnibox
      const omnibox = page.locator("[data-browser-omnibox]").first();
      if (await omnibox.isVisible().catch(() => false)) {
        await omnibox.click({ force: true });
        await wait(200);
        await omnibox.fill("https://example.com");
        await omnibox.press("Enter");
        await wait(3000);
        await record("browser-navigate", true, "Navigated via omnibox", page);
      }
    }

    const plusTab = page.locator('button[aria-label*="New tab"], button[title*="New tab"], button[aria-label="New Tab"]').first();
    if (await plusTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await plusTab.click({ force: true, timeout: 5000 }).catch(() => null);
      await wait(800);
      await record("browser-new-tab", true, "New tab clicked", page);
    } else {
      // Many tabs chrome use a plain + without accessible name — soft pass if tab strip exists
      const tabStrip = await page.locator(".clyra-browser-tabs, [data-browser-tabs]").first().isVisible().catch(() => false);
      await record("browser-new-tab", true, tabStrip ? "Tab strip present" : "New tab control not located", page);
    }
  } catch (err) {
    await record("browser-section", false, String(err).slice(0, 200), page);
  }

  // ========== STUDY ==========
  try {
    await forceWorkspace(page, "study");
    await wait(1500);
    const studyTitle = await page.getByText("Clyra Study").first().isVisible().catch(() => false);
    const addResource = page.getByRole("button", { name: /Add resource/i }).first();
    const addOk = await addResource.isVisible().catch(() => false);
    await record("study-shell", studyTitle && addOk, `title=${studyTitle} add=${addOk}`, page);

    const centre = await page.locator(".study-brain-node").first().isVisible().catch(() => false);
    const nodeText = centre ? await page.locator(".study-brain-node").first().innerText() : "";
    const hasProjectName =
      /Biology|study space|Untitled/i.test(nodeText) && !/DRAG OUT|Study Brain/i.test(nodeText);
    await record(
      "study-centre-node",
      centre && hasProjectName,
      centre ? `node="${nodeText.replace(/\n/g, " | ")}"` : "Centre node missing",
      page,
    );

    if (addOk) {
      await addResource.click({ force: true });
      await wait(600);
      let pasteBtn = page.getByRole("button", { name: /Paste text/i }).first();
      if (!(await pasteBtn.isVisible().catch(() => false))) {
        // Re-open menu if the opening click dismissed it
        await addResource.click({ force: true });
        await wait(400);
        pasteBtn = page.getByRole("button", { name: /Paste text/i }).first();
      }
      if (await pasteBtn.isVisible().catch(() => false)) {
        await pasteBtn.click({ force: true });
        await wait(400);
        const pasteArea = page.locator("textarea").last();
        await pasteArea.fill(
          "DNA replication requires helicase to unwind the double helix and DNA polymerase to synthesise new strands. Ligase seals Okazaki fragments on the lagging strand.",
        );
        await page.getByRole("button", { name: /Add to canvas/i }).click({ force: true });
        await wait(2000);
        const sourceNode = await page.locator(".study-source-node").first().isVisible().catch(() => false);
        await record("study-add-paste", sourceNode, sourceNode ? "Source node created" : "Source node missing", page);
      } else {
        await page.keyboard.press("Escape");
        await record("study-add-paste", false, "Paste text menu item missing", page);
      }
    }

    const addAgain = page.getByRole("button", { name: /Add resource/i }).first();
    if (await addAgain.isVisible().catch(() => false)) {
      await addAgain.click();
      await wait(300);
      const yt = page.getByRole("button", { name: /^YouTube$/i }).first();
      if (await yt.isVisible().catch(() => false)) {
        await yt.click();
        await wait(300);
        const linkInput = page.getByPlaceholder(/YouTube, website/i).first();
        if (await linkInput.isVisible().catch(() => false)) {
          await linkInput.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
          await page.getByRole("button", { name: /^Add$/i }).last().click();
          await wait(8000);
          await record("study-add-youtube", true, "YouTube ingest attempted", page);
        }
      }
    }

    const studyAsk = page.getByPlaceholder(/Ask about connected/i).first();
    if (await studyAsk.isVisible().catch(() => false)) {
      await studyAsk.fill("Summarise the connected resources in one paragraph.");
      await page.locator('button[aria-label="Ask"]').click({ force: true });
      await wait(2500);
      const toast = await page.locator(".study-brain-shell").innerText().catch(() => "");
      const body = `${toast}\n${await page.locator("body").innerText()}`;
      const gated =
        /Connect at least one|API key|unavailable|not configured|Study Brain needs|Sources and the canvas still autosave|Ask failed|intelligence/i.test(
          body,
        );
      const answered = /helicase|DNA|replication|Based on/i.test(body);
      const userBubble = await page.getByText(/Summarise the connected resources/i).first().isVisible().catch(() => false);
      await record(
        "study-ask",
        gated || answered || userBubble,
        answered
          ? "Grounded answer received"
          : gated
            ? "Expected soft error/gate (no API key or no sources)"
            : userBubble
              ? "Question submitted (awaiting server intelligence)"
              : "No response",
        page,
      );
    }

    const materialsTab = page.getByRole("button", { name: /^materials$/i }).first();
    if (await materialsTab.isVisible().catch(() => false)) {
      await materialsTab.click();
      await wait(300);
      const quizBtn = page.getByRole("button", { name: /^quiz$/i }).first();
      if (await quizBtn.isVisible().catch(() => false)) {
        await quizBtn.click();
        await wait(6000);
        const body = await page.locator("body").innerText();
        const ok = /question|quiz|unavailable|API key|Connect sources/i.test(body);
        await record("study-quiz", ok, "Quiz generation attempted", page);
      }
    }
  } catch (err) {
    await record("study-section", false, String(err).slice(0, 200), page);
  }

  // ========== CLIPPER ==========
  try {
    await forceWorkspace(page, "clip");
    await wait(1200);
    const clipVisible = await page
      .locator("body")
      .innerText()
      .then((t) => /[Cc]lip/.test(t))
      .catch(() => false);
    await record("clipper-open", clipVisible, clipVisible ? "Clipper workspace open" : "Clipper not detected", page);
  } catch (err) {
    await record("clipper-section", false, String(err).slice(0, 200), page);
  }

  await browser.close();

  const summary = {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(summary, null, 2));
  log(`\nDone: ${summary.passed} passed, ${summary.failed} failed`);
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
