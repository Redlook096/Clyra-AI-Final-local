/**
 * Complex multi-step AI Browser shopping flow — every step must verify.
 * Mirrors the openbrowser-e2e action/observe contract so it never stops early.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_URL || "http://127.0.0.1:3000";
const OUT = process.env.CLYRA_VISUAL_ARTIFACTS || "/opt/cursor/artifacts";
const fixturePort = 43141;
await fs.mkdir(OUT, { recursive: true });

const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"/><title>Complex Shop</title>
<style>
body{margin:0;font:16px system-ui;background:#f6f8fb;color:#172033}
header{padding:18px 8vw;background:#fff;border-bottom:1px solid #dde3eb}
main{width:min(900px,88vw);margin:28px auto}
form{display:flex;gap:10px;margin:16px 0}
input,select,button{min-height:40px;border-radius:8px;border:1px solid #cbd5e1;padding:0 12px}
button{background:#111827;color:#fff;cursor:pointer}
.card{background:#fff;border:1px solid #dfe5ed;border-radius:10px;padding:16px;margin:12px 0}
#cookie{position:fixed;right:24px;bottom:24px;width:280px;padding:16px;background:#fff;border:1px solid #cbd5e1;box-shadow:0 14px 40px #0f172a22;z-index:5}
#cart{margin-top:18px;padding:14px;background:#eef4ff;border-radius:10px}
.done{color:#067647;font-weight:600}
</style></head><body>
<header><strong>Complex Shop</strong></header>
<main>
<h1>Beach essentials</h1>
<form id="filters">
  <input id="q" aria-label="Search products" placeholder="Search products"/>
  <select id="price" aria-label="Max price"><option value="50">$50</option><option value="30">$30</option></select>
  <button type="submit" id="apply">Apply filters</button>
</form>
<label><input id="instock" type="checkbox" aria-label="In stock only"/> In stock only</label>
<p id="status" role="status">Showing all products</p>
<section id="results">
  <article class="card" data-sku="sunscreen"><h2>Reef-safe sunscreen SPF50</h2><p>$24 · 4.8★</p><button class="add" data-name="sunscreen" aria-label="Add sunscreen">Add sunscreen</button></article>
  <article class="card" data-sku="towel"><h2>Quick-dry beach towel</h2><p>$18 · 4.6★</p><button class="add" data-name="towel" aria-label="Add towel">Add towel</button></article>
  <article class="card" data-sku="hat"><h2>Wide brim bucket hat</h2><p>$22 · 4.7★</p><button class="add" data-name="hat" aria-label="Add hat">Add hat</button></article>
</section>
<div id="cart"><strong>Cart</strong><ul id="cart-list"></ul><p id="checkout-status">Cart empty</p>
<button id="checkout" aria-label="Checkout" disabled>Checkout</button></div>
</main>
<aside id="cookie" role="dialog"><p>Cookie preferences</p><button id="dismiss" aria-label="Dismiss cookie banner">Dismiss cookie banner</button></aside>
<script>
const cart=[];
const refresh=()=>{
  const list=document.getElementById('cart-list');
  list.innerHTML=cart.map(i=>'<li>'+i+'</li>').join('');
  document.getElementById('checkout-status').textContent=cart.length?('Items: '+cart.join(', ')):'Cart empty';
  document.getElementById('checkout').disabled=cart.length<3;
};
document.getElementById('dismiss').onclick=()=>document.getElementById('cookie').remove();
document.getElementById('filters').onsubmit=(e)=>{
  e.preventDefault();
  const q=document.getElementById('q').value.trim()||'all';
  const price=document.getElementById('price').value;
  document.getElementById('status').textContent='Filtered for '+q+' under $'+price;
};
document.getElementById('instock').onchange=(e)=>{
  if(e.target.checked) document.getElementById('status').textContent='In-stock items only';
};
document.querySelectorAll('.add').forEach(btn=>btn.onclick=()=>{ cart.push(btn.dataset.name); refresh(); });
document.getElementById('checkout').onclick=()=>{
  document.getElementById('checkout-status').innerHTML='<span class="done">Checkout complete for '+cart.join(', ')+'</span>';
};
</script></body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fixtureHtml);
});
await new Promise((resolve) => server.listen(fixturePort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

async function api(pathname, init = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json", ...(init.headers || {}) } : init.headers,
  });
  const payload = await response.json();
  assert.equal(response.ok && payload.ok !== false, true, `${pathname}: ${payload?.error?.message || response.statusText}`);
  return payload;
}

async function action(value) {
  const payload = await api("/api/openbrowser/action", {
    method: "POST",
    body: JSON.stringify({ action: value }),
  });
  if (payload.verification && payload.verification.ok === false) {
    throw new Error(`${value.type} not verified: ${payload.verification.summary}`);
  }
  return payload;
}

async function observe() {
  return (await api("/api/openbrowser/observe")).observation;
}

function elementByName(observation, name) {
  const element = (observation.elements || []).find(
    (candidate) => candidate.name === name || candidate.label === name || candidate.text === name,
  );
  assert.ok(element, `Expected visible element named "${name}"`);
  return { elementId: element.id };
}

const steps = [];
const mark = (name, ok, detail = {}) => {
  steps.push({ name, ok, ...detail });
  console.log(ok ? "ok" : "FAIL", name, detail.note || detail.error || "");
};

try {
  await api("/api/openbrowser/navigate", { method: "POST", body: JSON.stringify({ target: fixtureUrl }) });
  mark("navigate", true);

  let observation = await observe();
  assert.match(String(observation.page?.title || ""), /Complex Shop/i);
  mark("observe-title", true);

  for (const name of ["Search products", "Apply filters", "In stock only", "Dismiss cookie banner", "Add sunscreen", "Add towel", "Add hat"]) {
    assert.ok(
      observation.elements.some((el) => el.name === name || el.label === name || el.text === name),
      `Missing control: ${name}`,
    );
  }
  mark("observe-controls", true);

  await action({ type: "click", target: elementByName(observation, "Dismiss cookie banner") });
  mark("dismiss-cookie", true);
  observation = await observe();
  assert.equal(observation.elements.some((item) => item.name === "Dismiss cookie banner"), false);

  await action({
    type: "type",
    target: elementByName(observation, "Search products"),
    text: "sunscreen towel hat",
    clearFirst: true,
  });
  mark("type-search", true);

  observation = await observe();
  await action({ type: "click", target: elementByName(observation, "Apply filters") });
  mark("apply-filters", true);

  observation = await observe();
  assert.match(String(observation.mainText || ""), /Filtered for sunscreen towel hat under \$/);
  mark("verify-filter", true);

  observation = await observe();
  await action({ type: "check", target: elementByName(observation, "In stock only") });
  mark("toggle-instock", true);

  for (const label of ["Add sunscreen", "Add towel", "Add hat"]) {
    observation = await observe();
    await action({ type: "click", target: elementByName(observation, label) });
    mark(`click-${label}`, true);
  }

  await action({ type: "scroll", direction: "down", amount: 700 }).catch(() => undefined);
  observation = await observe();
  let checkoutTarget = (observation.elements || []).find(
    (el) => el.name === "Checkout" || el.label === "Checkout" || el.text === "Checkout",
  );
  if (!checkoutTarget) {
    // Disabled controls are sometimes omitted until a second observe after cart updates.
    await new Promise((r) => setTimeout(r, 250));
    observation = await observe();
    checkoutTarget = (observation.elements || []).find(
      (el) => /checkout/i.test(String(el.name || el.label || el.text || "")),
    );
  }
  assert.ok(checkoutTarget, "Checkout control never became visible after filling the cart");
  await action({ type: "click", target: { elementId: checkoutTarget.id } });
  mark("checkout", true);

  observation = await observe();
  assert.match(String(observation.mainText || ""), /Checkout complete for sunscreen, towel, hat/i);
  mark("verify-checkout", true, { note: "full cart checked out" });

  // Atlas UI + Task View visual checks
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/?embedTool=browser&browserDemo=agent`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, "atlas-ui-01-demo.png") });
  const ask = page.getByRole("button", { name: /Ask Clyra/i }).first();
  if (await ask.count()) await ask.click().catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "atlas-ui-02-ask-panel.png") });
  await page.keyboard.press("Control+J");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "atlas-ui-03-task-view.png") });
  const taskViewVisible = await page.locator("text=Task View").first().isVisible().catch(() => false);
  mark("task-view-open", taskViewVisible, { note: taskViewVisible ? "Cmd/Ctrl+J opened Task View" : "overlay not visible in web shell" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, "atlas-ui-04-after-taskview.png") });
  await browser.close();

  const report = {
    ok: steps.every((step) => step.ok),
    steps,
    fixtureUrl,
    at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(OUT, "browser-complex-task.json"), JSON.stringify(report, null, 2));
  assert.equal(report.ok, true, JSON.stringify(steps.filter((s) => !s.ok)));
  console.log("PASS complex browser task", steps.filter((s) => s.ok).length, "/", steps.length);
} catch (error) {
  console.error(error);
  await fs.writeFile(
    path.join(OUT, "browser-complex-task.json"),
    JSON.stringify({ ok: false, steps, error: String(error?.stack || error) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  server.close();
}
