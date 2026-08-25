const { chromium } = require("playwright");

const BASE = "http://localhost:3000";
const results = [];
const failures = [];
function ok(n, d = "") { results.push(`PASS  ${n}${d ? ` — ${d}` : ""}`); }
function bad(n, d = "") { failures.push(`FAIL  ${n}${d ? ` — ${d}` : ""}`); }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  const failedResponses = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
  page.on("response", (r) => { if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  await page.goto(`${BASE}/?embedTool=vibe`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('textarea[placeholder*="Ask Clyra"]', { timeout: 60000 });
  await page.waitForTimeout(2500);

  const textarea = () => page.locator('textarea[placeholder*="Ask Clyra"]').first();

  if (/Ask Clyra/i.test((await textarea().getAttribute("placeholder")) || "")) ok("composer rendered");
  else bad("composer rendered");

  // 1. Demo trigger
  await textarea().click();
  await textarea().fill("/ask");
  await textarea().press("Enter");
  await page.waitForTimeout(900);
  const demoVisible = await page.locator('[data-testid="question-composer"]').count();
  if (demoVisible > 0) ok("demo /ask opened question panel");
  else bad("demo /ask opened question panel");

  const demoQ = await page.getByText("Which layout should I use?").count();
  if (demoQ > 0) ok("demo panel shows question text (no wizard title)");
  else bad("demo panel shows question text");

  const demoOptions = await page.locator('[data-testid="question-composer"] [data-q-option]').allTextContents();
  if (demoOptions.length >= 8) ok("demo panel has questions+options", demoOptions.length + " options");
  else bad("demo panel has questions+options", demoOptions.length + " options");

  // Answer one option per demo question.
  for (const qid of ["layout", "animations", "scope", "direction"]) {
    const opt = page.locator(`[data-q-id="${qid}"]`).first();
    if (await opt.count()) await opt.click({ force: true });
  }
  await page.waitForTimeout(300);
  const cont = page.locator('[data-testid="question-continue"]');
  if ((await cont.count()) && (await cont.isEnabled())) { await cont.click({ force: true }); ok("demo Continue enabled + clicked"); }
  else bad("demo Continue enabled", `count=${await cont.count()}`);
  await page.waitForTimeout(900);
  if ((await page.locator('textarea[placeholder*="Ask Clyra"]').count()) > 0) ok("demo panel closed back to normal input");
  else bad("demo panel closed back to normal input");

  // 2. Platform ambiguity
  await textarea().click();
  await textarea().fill("give it an iOS theme");
  await textarea().press("Enter");
  await page.waitForTimeout(900);
  const platformTitle = await page.getByText("Which platform should I target?").count();
  if (platformTitle > 0) ok("ambiguous prompt opened platform question");
  else bad("ambiguous prompt opened platform question");
  const platformOptions = await page.locator('[data-q-id="platform"]').allTextContents();
  if (platformOptions.length >= 3 && platformOptions.some((t) => t.includes("Webapp/Website")) && platformOptions.some((t) => t.includes("Desktop app"))) ok("platform options present", platformOptions.join(", "));
  else bad("platform options present", platformOptions.join(", "));

  // Select iOS app, Continue -> triggers real run.
  const iosOpt = page.locator('[data-q-id="platform"]', { hasText: "iOS app" }).first();
  if (await iosOpt.count()) { await iosOpt.click({ force: true }); ok("selected iOS app"); }
  else bad("selected iOS app");
  await page.waitForTimeout(300);
  const cont2 = page.locator('[data-testid="question-continue"]');
  if ((await cont2.count()) && (await cont2.isEnabled())) { await cont2.click({ force: true }); ok("platform question submitted (real run kicked off)"); }
  else bad("platform question submitted", `count=${await cont2.count()}`);

  // Answer should render as compact UI in the user bubble (not raw directive).
  await page.waitForTimeout(2000);
  const answerInBubble = await page.getByText("iOS app", { exact: true }).count();
  const questionInBubble = await page.getByText("Which platform should I target?").count();
  if (answerInBubble > 0 && questionInBubble > 0) ok("answers rendered as compact UI in user bubble");
  else bad("answers rendered as compact UI", `answer=${answerInBubble}, question=${questionInBubble}`);

  await page.screenshot({ path: "tmp/vibe-e2e-final.png" });

  // 3. Error reporting
  const seriousResponses = failedResponses.filter((f) => !/sessions\//.test(f));
  if (seriousResponses.length === 0) ok("no failed HTTP responses (non-sessions)", `${failedResponses.length} total sessions-list filtered`);
  else bad("no failed HTTP responses", seriousResponses.slice(0, 5).join(" | "));

  console.log("\n===== RESULTS =====");
  for (const r of results) console.log(r);
  for (const f of failures) console.log(f);
  console.log(`\n${results.length} passed, ${failures.length} failed`);
  console.log("\n===== CONSOLE ERRORS (deduped) =====");
  console.log([...new Set(consoleErrors)].slice(0, 20).join("\n") || "(none)");
  console.log("\n===== FAILED RESPONSES (deduped) =====");
  console.log([...new Set(failedResponses)].slice(0, 20).join("\n") || "(none)");

  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error("E2E crashed:", e.message); process.exit(2); });
