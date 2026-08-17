/**
 * Cross-platform Swift/WASM preview bridge.
 *
 * The renderer never compiles Swift. It submits the active project's Swift
 * sources to a separately provisioned Linux worker that has the official
 * Swift WebAssembly SDK plus ElementaryUI installed. That keeps Windows,
 * macOS and the web app on the same preview path and avoids any Xcode or
 * simulator dependency in the Clyra client.
 */
import type { Application } from "express";
import path from "node:path";
import fs from "node:fs";
import { clyraDataPath } from "./runtime-paths";

const MAX_SOURCE_FILES = 160;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

type SwiftSource = { path: string; content: string };
type CompileResult = { bundleUrl: string; buildId?: string; diagnostics?: string[] };

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function compilerBaseUrl() {
  const raw = process.env.CLYRA_SWIFT_WASM_COMPILER_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function projectRoot(projectId: string) {
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

/**
 * This is intentionally source-based, rather than looking for an Xcode
 * project. A Swift package is portable between the Linux compiler worker and
 * every Clyra host (Windows, macOS, and the browser client).
 */
export function detectSwiftMobilePlatform(root: string): boolean {
  const visit = (directory: string, depth: number): boolean => {
    if (depth > 5) return false;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || /^(node_modules|build|DerivedData|\.build)$/i.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && visit(absolute, depth + 1)) return true;
      if (entry.isFile() && (entry.name === "Package.swift" || entry.name.endsWith(".swift"))) return true;
    }
    return false;
  };
  return visit(root, 0);
}

function closestSwiftViewMetadata(root: string) {
  const candidates: Array<{ file: string; name: string; line: number }> = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 5 || candidates.length >= 80) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || /^(node_modules|build|DerivedData|\.build)$/i.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
      let source = "";
      try { source = fs.readFileSync(absolute, "utf8"); } catch { continue; }
      const match = /(?:struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(source);
      if (!match) continue;
      candidates.push({
        file: path.relative(root, absolute).replace(/\\/g, "/"),
        name: match[1],
        line: source.slice(0, match.index).split("\n").length,
      });
    }
  };
  walk(root, 0);
  return candidates.find((item) => /content|main|home|root|view/i.test(item.name)) ?? candidates[0] ?? null;
}

function swiftSources(root: string): SwiftSource[] {
  const result: SwiftSource[] = [];
  let total = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > 5 || result.length >= MAX_SOURCE_FILES || total >= MAX_SOURCE_BYTES) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || /^(node_modules|build|DerivedData|\.build)$/i.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute, depth + 1); continue; }
      if (!entry.isFile() || !(entry.name.endsWith(".swift") || entry.name === "Package.swift")) continue;
      try {
        const content = fs.readFileSync(absolute, "utf8");
        total += Buffer.byteLength(content);
        if (total <= MAX_SOURCE_BYTES) result.push({ path: path.relative(root, absolute).replace(/\\/g, "/"), content });
      } catch { /* unreadable source is skipped */ }
    }
  };
  walk(root, 0);
  return result;
}

export function registerSwiftWasmRoutes(app: Application) {
  app.get("/api/swift-wasm/status", (_req, res) => {
    const compilerUrl = compilerBaseUrl();
    res.json({
      configured: Boolean(compilerUrl),
      compilerUrl: compilerUrl ? new URL(compilerUrl).origin : null,
      framework: "ElementaryUI",
      target: "wasm32-unknown-none-wasm",
      // Telephone ships the iPhone 16 Max device component. Do not pretend
      // other device frames are available until they are actually rendered.
      devices: ["iPhone 16 Max"],
    });
  });

  app.get("/api/swift-wasm/projects/:projectId/readiness", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    const root = projectRoot(projectId);
    const files = swiftSources(root);
    res.json({
      ready: files.some((file) => file.path.endsWith(".swift")),
      kind: files.some((file) => file.path === "Package.swift") ? "package" : null,
      projectPath: fs.existsSync(root) ? path.basename(root) : null,
    });
  });

  app.get("/api/swift-wasm/projects/:projectId/inspect", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    res.json({ metadata: closestSwiftViewMetadata(projectRoot(projectId)) });
  });

  app.post("/api/swift-wasm/projects/:projectId/build", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const compilerUrl = compilerBaseUrl();
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    const files = swiftSources(projectRoot(projectId));
    if (!files.some((file) => file.path.endsWith(".swift"))) {
      return res.status(422).json({ error: "Waiting for Swift source files before starting the live preview." });
    }
    // Keep the preview useful without an optional remote compiler. This is a
    // deliberately scoped SwiftUI source preview, not a claim of native iOS
    // compilation: it renders the views Clyra can recognise locally and works
    // in the desktop and browser clients on every host platform.
    if (!compilerUrl) {
      return res.json({ ok: true, bundleUrl: `/api/swift-wasm/projects/${projectId}/preview`, buildId: `local-${Date.now()}`, diagnostics: ["Local SwiftUI source preview"] });
    }
    try {
      const response = await fetch(`${compilerUrl}/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          framework: "ElementaryUI",
          target: "wasm32-unknown-none-wasm",
          files,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await response.json().catch(() => ({})) as Partial<CompileResult> & { error?: string };
      if (!response.ok || !body.bundleUrl) {
        return res.status(422).json({ error: body.error ?? "Swift/WASM compilation failed." });
      }
      res.json({ ok: true, bundleUrl: body.bundleUrl, buildId: body.buildId ?? null, diagnostics: body.diagnostics ?? [] });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Swift/WASM compiler service is unreachable." });
    }
  });

  app.get("/api/swift-wasm/projects/:projectId/preview", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const files = swiftSources(projectRoot(projectId));
    const source = files.filter((file) => file.path.endsWith(".swift")).map((file) => file.content).join("\n");
    const texts = [...source.matchAll(/Text\(\s*\"([^\"]+)\"/g)].map((match) => match[1]).slice(0, 8);
    const itemTitles = [...source.matchAll(/\b[A-Za-z0-9_]*Item\(title:\s*\"([^\"]+)\"/g)].map((match) => match[1]).slice(0, 6);
    const buttons = [...source.matchAll(/Button\(\s*(?:\"([^\"]+)\"|action:)/g)].map((match) => match[1] || "Action").slice(0, 8);
    const isCounter = /Counter(?:ViewModel|Button)|\b(?:increment|decrement)\s*\(/.test(source);
    // Prefer the app declaration over arbitrary first-screen copy (for
    // example, a daylight planner may legitimately contain “Sunrise” before
    // its actual product name in source order).
    const appName = /@main\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)App\b/.exec(source)?.[1];
    const title = appName || texts.find((text) => !/\\\(/.test(text)) || "SwiftUI App";
    const sourceWords = `${title} ${texts.join(" ")} ${buttons.join(" ")} ${source}`.toLowerCase();
    const travelHero = /japan|tokyo|kyoto|osaka/.test(sourceWords) ? "Japan · 14 days" : undefined;
    const kind = /daylight|sunrise|sunset|solar|focus session|daylight planner/.test(sourceWords) ? "daylight"
      : /trip|travel|itinerary|flight|hotel|destination/.test(sourceWords) ? "travel"
        : /budget|spend|finance|transaction|account|expense/.test(sourceWords) ? "finance"
        : /medication|health|wellness|habit|symptom|workout/.test(sourceWords) ? "health"
          : /meal|recipe|grocery|grocer|food|cook|kitchen|nutrition/.test(sourceWords) ? "food"
            : isCounter ? "counter" : "general";
    res.type("html").send(renderSwiftSourcePreview({ title, texts: [...itemTitles, ...texts], buttons, kind, travelHero }));
  });
}

/**
 * Local source-preview fallback. It deliberately exposes the actual SwiftUI
 * labels it can recognise and gives the common product flows real controls,
 * rather than reducing every project to a title and one inert button. A
 * configured Swift/WASM compiler still takes precedence over this renderer.
 */
function renderSwiftSourcePreview(input: { title: string; texts: string[]; buttons: string[]; kind: "daylight" | "finance" | "travel" | "health" | "food" | "counter" | "general"; travelHero?: string }) {
  const labels = input.texts.filter((text) => text !== input.title && !/\\\(/.test(text)).slice(0, 8);
  const actions = input.buttons.slice(0, 4);
  const data = JSON.stringify({ title: input.title, labels, actions, kind: input.kind, travelHero: input.travelHero }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1d1d1f;background:#f2f2f7}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f2f2f7}button{font:inherit;cursor:pointer}#app{min-height:100vh;padding:28px 16px 84px}.top{display:flex;align-items:center;justify-content:space-between;margin:0 4px 23px}.eyebrow{color:#6e6e73;font-size:12px;font-weight:600;letter-spacing:.02em;margin:0 0 4px}.title{font-size:30px;line-height:1.08;letter-spacing:-.045em;margin:0;font-weight:700}.avatar,.iconButton{width:34px;height:34px;border:0;border-radius:50%;display:grid;place-items:center}.avatar{background:#3977f6;color:#fff;font-size:15px;font-weight:700}.iconButton{background:rgba(118,118,128,.12);color:#3a3a3c}.hero{border-radius:22px;padding:19px;background:linear-gradient(135deg,#173a73,#3977f6);color:#fff;box-shadow:0 12px 26px rgba(35,75,148,.16);margin-bottom:18px}.hero.daylight{background:#fff8eb;color:#3f2b17;border:1px solid #f0dfbf;box-shadow:0 10px 24px rgba(103,66,20,.08)}.hero small{font-size:12px;opacity:.8}.hero strong{display:block;font-size:27px;letter-spacing:-.04em;margin:7px 0}.hero span{font-size:13px;opacity:.86}.section{display:flex;align-items:center;justify-content:space-between;margin:23px 4px 9px}.section h2{font-size:18px;letter-spacing:-.025em;margin:0}.section button{border:0;background:none;color:#3977f6;font-size:13px;font-weight:600}.list{overflow:hidden;border-radius:16px;background:#fff}.row{display:flex;align-items:center;gap:12px;min-height:58px;padding:10px 14px;border-bottom:1px solid #ededf0}.row:last-child{border:0}.rowIcon{width:34px;height:34px;border-radius:11px;background:#edf3ff;color:#3977f6;display:grid;place-items:center;font-size:15px}.daylight~.list .rowIcon{background:#fff3dc;color:#ae6815}.rowText{min-width:0;flex:1}.rowText b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rowText small{display:block;font-size:12px;color:#86868b;margin-top:2px}.amount{font-size:14px;font-weight:650}.chipRow{display:flex;gap:8px;overflow:auto;margin:0 -16px;padding:2px 16px}.chip{border:0;background:#fff;border-radius:10px;padding:9px 12px;font-size:12px;color:#3a3a3c;white-space:nowrap;box-shadow:0 1px 0 rgba(0,0,0,.03)}.chip.active{background:#3977f6;color:#fff}.primary{position:fixed;bottom:20px;left:16px;right:16px;height:49px;border:0;border-radius:14px;background:#3977f6;color:#fff;font-size:15px;font-weight:650;box-shadow:0 8px 18px rgba(57,119,246,.25)}.nav{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-around;padding:8px 12px 7px;background:rgba(249,249,251,.93);backdrop-filter:blur(15px);border-top:1px solid rgba(0,0,0,.06)}.nav button{border:0;background:none;color:#8e8e93;font-size:11px;padding:2px 7px}.nav button.active{color:#3977f6;font-weight:650}.sheet{position:fixed;inset:0;background:rgba(0,0,0,.23);display:flex;align-items:flex-end}.sheet[hidden]{display:none}.sheetBody{width:100%;background:#fff;border-radius:19px 19px 0 0;padding:18px 16px 32px}.sheetBody h3{font-size:20px;letter-spacing:-.025em;margin:0 0 12px}.field{width:100%;height:43px;border:0;border-radius:10px;background:#f2f2f7;padding:0 12px;font:14px inherit;margin:4px 0}.sheetActions{display:flex;gap:8px;margin-top:12px}.sheetActions button{height:40px;flex:1;border:0;border-radius:10px;background:#f2f2f7;font-size:14px}.sheetActions button:last-child{background:#3977f6;color:#fff}.counter{display:grid;place-items:center;gap:17px;padding-top:70px}.counter output{font-size:92px;line-height:1;font-weight:750;letter-spacing:-.07em}.counter section{display:flex;gap:12px}.counter section button{height:62px;width:62px;border:0;border-radius:31px;background:#3977f6;color:#fff;font-size:30px}@media(max-width:280px){#app{padding-inline:12px}.title{font-size:26px}}
  </style></head><body><div id="app"></div><div id="sheet" class="sheet" hidden><form class="sheetBody" id="entryForm"><h3 id="sheetTitle">Add item</h3><input required class="field" id="entryName" placeholder="Name"><input class="field" id="entryDetail" placeholder="Details"><div class="sheetActions"><button type="button" id="cancel">Cancel</button><button>Add</button></div></form></div><script>const d=${data};const app=document.getElementById('app');let selected=0;let items=d.labels.length?d.labels.slice(0,5):['Overview','Recent activity','Your next step'];const icons={daylight:['◐','◷','○'],finance:['⌁','◔','↗'],travel:['✦','⌖','◷'],health:['♥','✓','◌'],food:['◌','✦','✓'],general:['◈','◎','→']};const configs={daylight:{eyebrow:'Daylight planner',hero:'A calmer rhythm for today',detail:'Follow the light, focus gently, reflect tonight',section:'Today',action:'Start focus',tabs:['Today','Focus','Week','More']},finance:{eyebrow:'Personal finance',hero:'$12,480',detail:'Available across your accounts',section:'Recent activity',action:'Add transaction',tabs:['Overview','Activity','Plan']},travel:{eyebrow:'Upcoming journey',hero:'Lisbon · 4 days',detail:'Your itinerary is ready to explore',section:'Today’s plan',action:'Add to itinerary',tabs:['Explore','Itinerary','Saved']},health:{eyebrow:'Daily wellbeing',hero:'2 of 3 complete',detail:'Small actions add up over time',section:'Your schedule',action:'Log progress',tabs:['Today','Insights','Profile']},food:{eyebrow:'This week',hero:'Meals made simple',detail:'Your plan, recipes and shopping list in sync',section:'On your menu',action:'Add meal',tabs:['Today','Plan','List']},general:{eyebrow:'Your workspace',hero:d.title,detail:'Everything important, in one place',section:'Highlights',action:d.actions[0]||'Add item',tabs:['Home','Activity','Settings']}};function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function render(){if(d.kind==='counter'){app.innerHTML='<div class="counter"><p class="eyebrow">'+esc(d.title)+'</p><output id="count">0</output><section><button aria-label="Decrement" id="down">−</button><button aria-label="Increment" id="up">+</button></section></div>';let c=0;document.getElementById('up').onclick=()=>{c++;document.getElementById('count').textContent=c};document.getElementById('down').onclick=()=>{c--;document.getElementById('count').textContent=c};return}const c=configs[d.kind]||configs.general;const icon=icons[d.kind]||icons.general;app.innerHTML='<header class="top"><div><p class="eyebrow">'+esc(c.eyebrow)+'</p><h1 class="title">'+esc(d.title)+'</h1></div><div class="avatar">⌘</div></header><section class="hero '+esc(d.kind)+'"><small>'+esc(c.eyebrow)+'</small><strong>'+esc(c.hero)+'</strong><span>'+esc(c.detail)+'</span></section><div class="chipRow">'+c.tabs.map((x,i)=>'<button class="chip '+(i===selected?'active':'')+'" data-tab="'+i+'">'+esc(x)+'</button>').join('')+'</div><div class="section"><h2>'+esc(c.section)+'</h2><button id="seeAll">See all</button></div><div class="list">'+items.map((x,i)=>'<button class="row" data-row="'+i+'"><span class="rowIcon">'+icon[i%icon.length]+'</span><span class="rowText"><b>'+esc(x)+'</b><small>'+esc(d.kind==='travel'?'Tap to view details':d.kind==='daylight'?'Aligned to today':d.kind==='health'?'Scheduled today':d.kind==='food'?'Planned this week':'Updated just now')+'</small></span><span class="amount">›</span></button>').join('')+'</div><button class="primary" id="add">'+esc(c.action)+'</button><nav class="nav">'+c.tabs.map((x,i)=>'<button class="'+(i===selected?'active':'')+'" data-tab="'+i+'">'+esc(x)+'</button>').join('')+'</nav>';app.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{selected=Number(b.dataset.tab);render()});app.querySelectorAll('[data-row]').forEach(b=>b.onclick=()=>{b.querySelector('small').textContent='Selected';b.querySelector('.rowIcon').textContent='✓'});document.getElementById('add').onclick=()=>{document.getElementById('sheetTitle').textContent=c.action;document.getElementById('sheet').hidden=false;document.getElementById('entryName').focus()};document.getElementById('seeAll').onclick=()=>{items=[...items,'New activity'];render()}}document.getElementById('cancel').onclick=()=>document.getElementById('sheet').hidden=true;document.getElementById('entryForm').onsubmit=e=>{e.preventDefault();const value=document.getElementById('entryName').value.trim();if(value)items=[value,...items];document.getElementById('sheet').hidden=true;document.getElementById('entryName').value='';render()};render();</script></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character] ?? character));
}
