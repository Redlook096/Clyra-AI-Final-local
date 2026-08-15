import type { Application } from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { clyraDataPath } from "../runtime-paths";
import { codingModelStatus, openCodeRuntimeManager } from "./OpenCodeRuntimeManager";
import { detectMobileSwiftProject } from "../mobile-preview-routes";

const execFileAsync = promisify(execFile);

const IOS_AGENTS_MD = `# Clyra Code Agent — Cross-platform SwiftUI Source Mode

You are building a portable Swift/SwiftUI application source workspace. Clyra
must work consistently on macOS and Windows, so do not depend on Xcode,
xcodebuild, a physical iPhone, xtool, go-ios, WSL, or a platform-only simulator.
Never claim a native install or device build succeeded unless the configured
preview service has returned a real successful result.

Project architecture rules — for every coding request:
- Inspect the existing project structure first (list files and read Package.swift) and match its conventions.
- Split code across the standard layout — never generate the whole application inside one giant Swift file:
  App/  Views/  Components/  Models/  ViewModels/  Services/  Utilities/  Resources/  Tests/
- Use real SwiftUI and a portable Swift Package (Package.swift). Keep views small, focused and reusable.
- Reuse existing views and models instead of rebuilding them. Revisit and edit multiple files during the run when needed.
- Apple guidance lives in .agent/skills/ — apply its design guidance where compatible with ElementaryUI.
- The embedded preview can be unavailable on a host without a configured preview bridge. Generate correct reusable source and use portable/static checks where available; report the preview limitation plainly rather than attempting unavailable device tooling.
- Only claim completion for checks that actually ran. If validation fails, show the error, fix the file, and rerun the available validation.
- Use SF Symbols, Swift concurrency (async/await), and accessibility best practices.

Product and quality loop — adapt depth to the requested product before editing:
- Work through understand → inspect → product/UX plan → visual system → architecture → implement → validate → preview → critique → refine. Use the real todo tool for non-trivial work and revisit earlier phases when the result is weak.
- Infer the product's users, core job, primary flows, screen inventory, navigation and data states. Do not reuse a generic dashboard, a fixed tab bar, a hero card, or a four-card grid across unrelated products.
- Select an app-specific design direction (for example: calm editorial journaling, dense finance utility, media-first travel, focused professional tool). Establish a restrained type scale, 4/8/12/16/20/24/32 spacing rhythm, compact radii, surface hierarchy and action hierarchy before implementing views.
- Avoid generic template signals: inflated cards, giant pills, gradients, glowing surfaces, decorative sparkles, meaningless metrics, oversized headings, repeated tiles and dead controls. Use spacing, typography, grouped lists, separators and purposeful content to create hierarchy instead.
- Build complete flows, not only a polished home screen: include appropriate empty, populated, loading, error, edit, confirmation and settings states. Every visible action must have a real SwiftUI destination or behaviour.
- Use believable product-specific sample content so the preview can be judged. Keep state, navigation and persistence appropriate to the scope; never hard-code a complex product into one view.
- Before completion, run a real visual and interaction review in the available live preview: exercise navigation, primary actions, editing, cancellation, destructive actions and dynamic data. Repair clipping, weak hierarchy, inaccessible contrast, oversized controls, dead interactions or generic composition before finalising.
- Test compact, standard and large iPhone layouts conceptually in SwiftUI with safe areas and Dynamic Type in mind. Use meaningful accessibility labels and touch targets.
- The browser/preview tool is a real verification tool. When browser mode is requested, observe the active preview, interact with it, verify outcomes, repair source where necessary and re-test. Never claim interactions that did not occur.

Definition of done for an advanced iOS product:
- First create a compact internal product brief: user, primary job, primary flow, screen inventory, navigation choice, data model and design direction. Use this to drive implementation rather than inventing a generic dashboard.
- For a medium or advanced product, implement a minimum of four genuinely useful screens or states, at least three reusable components, a domain model, observable app state and believable populated sample data. The home screen alone is never enough.
- Wire every visible primary action to a real SwiftUI behaviour: navigation, edit/create flow, filtering, selection, sheet, alert, persistence mutation, or an explicit disabled/unavailable state with a reason. Do not leave decorative buttons.
- Build a stateful app: mutations must visibly update the appropriate screen and survive view refreshes when the scope calls for it. Prefer AppStorage/UserDefaults for small local persistence rather than fake static controls.
- Before finishing, inspect the complete app as a product designer. Remove repeated large cards, unused navigation destinations, placeholder labels, empty metric blocks, excessive rounded surfaces and controls that do not match the product's job. If the first version looks like a template, revise it before validating.
- Keep the portable preview honest: it is a source-driven Chromium preview unless an actual configured compiler reports a native build. Still make source layouts and interactions complete enough that the preview can exercise the core product flow.
`;

const APPLE_SKILL_SOURCE = path.resolve(process.cwd(), "lib/apple-skills-repo", "skills");
const SWIFTUI_SKILL_SOURCE = path.resolve(process.cwd(), "lib/swiftui-agent-skill-repo", "skills", "swiftui-expert-skill");

/**
 * Project workspaces live inside Clyra's data dir, which the parent repo
 * gitignores. OpenCode's snapshot/diff system needs a git worktree, so give
 * each project its own repo with a baseline commit. Without this, session
 * diffs are always empty and the UI cannot show real +/− statistics.
 */
async function ensureProjectGitRepo(root: string) {
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", root, ...args], { timeout: 15_000 });
  try {
    await fs.access(path.join(root, ".git"));
  } catch {
    await git("init", "--initial-branch=main").catch(() => git("init"));
    await git("config", "user.email", "agent@clyra.local");
    await git("config", "user.name", "Clyra Agent");
  }
  try {
    await git("rev-parse", "HEAD");
  } catch {
    // No commits yet: snapshot whatever already exists as the baseline.
    await git("add", "-A");
    await git("commit", "--allow-empty", "-m", "Clyra project baseline").catch(() => undefined);
  }
}

const MAX_PROMPT_LENGTH = 20_000;
// The request body is JSON/base64, so keep the decoded total safely inside
// Express's 16 MB body limit.
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;
const subscriptions = new Map<string, () => void>();

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function projectPath(projectId: string) {
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

function titleFor(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 72) || "New Clyra task";
}

function requestsIosProject(prompt: string) {
  return /\b(?:ios|iphone|ipad|swiftui|uikit|xcode|xcworkspace|xcodeproj)\b/i.test(prompt);
}

type IosStarterProfile = {
  title: string;
  kind: "finance" | "travel" | "health" | "productivity";
  subtitle: string;
  primaryAction: string;
  tabs: [string, string, string];
  items: Array<{ name: string; detail: string; amount: string }>;
};

function iOSStarterProfile(prompt: string): IosStarterProfile {
  const text = prompt.toLowerCase();
  const explicitName = /(?:called|named)\s+["“']?([A-Za-z][A-Za-z0-9 &'-]{2,32})/i.exec(prompt)?.[1]?.trim();
  // Also honor the natural “Build Ledgerly, …” form without treating a
  // generic “Build an app…” instruction as a product name.
  const buildName = /\bbuild\s+([A-Z][A-Za-z0-9'-]{2,32})(?=\s*[,.:])/i.exec(prompt)?.[1]?.trim();
  const named = explicitName || buildName;
  if (/budget|finance|money|expense|transaction|account/.test(text)) return {
    title: named || "Ledgerly", kind: "finance", subtitle: "A clearer view of every dollar", primaryAction: "Add transaction",
    tabs: ["Overview", "Activity", "Plan"],
    items: [{ name: "Northstar Card", detail: "Balance · updated today", amount: "$3,842" }, { name: "Weekly groceries", detail: "Food & dining · Today", amount: "−$68" }, { name: "Transit pass", detail: "Transport · Yesterday", amount: "−$42" }],
  };
  if (/travel|trip|itinerary|flight|hotel|destination|journey/.test(text)) return {
    title: named || "Wayfinder", kind: "travel", subtitle: "Plans that leave room for discovery", primaryAction: "Add to itinerary",
    tabs: ["Explore", "Itinerary", "Saved"],
    items: [{ name: "Alfama morning walk", detail: "Day 2 · 9:30 AM", amount: "›" }, { name: "Tasca da Sé", detail: "Dinner · Reservation saved", amount: "›" }, { name: "Belém train", detail: "Day 3 · 10:10 AM", amount: "›" }],
  };
  if (/health|medication|wellness|habit|symptom|workout|fitness/.test(text)) return {
    title: named || "Morrow", kind: "health", subtitle: "Small routines, clearly understood", primaryAction: "Log progress",
    tabs: ["Today", "Insights", "Profile"],
    items: [{ name: "Morning medication", detail: "8:00 AM · Due now", amount: "Start" }, { name: "Hydration", detail: "4 of 8 glasses", amount: "50%" }, { name: "Evening reflection", detail: "8:30 PM · Scheduled", amount: "›" }],
  };
  return {
    title: named || "Focus", kind: "productivity", subtitle: "The work that deserves your attention", primaryAction: "Create item",
    tabs: ["Today", "Projects", "Profile"],
    items: [{ name: "Shape the launch brief", detail: "Design · Due today", amount: "›" }, { name: "Review prototypes", detail: "Product · 3 notes", amount: "›" }, { name: "Plan the next sprint", detail: "Team · Tomorrow", amount: "›" }],
  };
}

/**
 * An iOS request should never leave a blank workspace while a provider is
 * recovering from its first tool turn. This is a genuine source scaffold,
 * not a preview-only mock: OpenCode receives the files and continues to
 * evolve them during its normal run. We only seed an otherwise empty Swift
 * workspace, so existing projects always remain user/agent owned.
 */
async function seedIosStarterIfEmpty(root: string, prompt: string) {
  let entries: string[] = [];
  try { entries = await fs.readdir(root, { recursive: true }) as string[]; } catch { /* created below */ }
  // Apple skills are copied into .agent and may themselves contain Swift
  // examples. They are instruction material, not application source, and
  // must not prevent a brand-new project from receiving its starter files.
  if (entries.some((entry) => !/(^|[\\/])(?:\.agent|\.git)(?:[\\/]|$)/.test(entry) && entry.endsWith(".swift"))) return false;
  const profile = iOSStarterProfile(prompt);
  const identifier = profile.title.replace(/[^A-Za-z0-9]/g, "") || "ClyraApp";
  const items = profile.items.map((item) => `        ${identifier}Item(title: "${item.name}", detail: "${item.detail}", trailing: "${item.amount}"),`).join("\n");
  const destinationTitles = profile.tabs.map((tab) => `case .${tab.toLowerCase()}: return "${tab}"`).join("\n        ");
  const files: Record<string, string> = {
    "Package.swift": `// Clyra portable SwiftUI source package\n// The on-device build target can provide SwiftUI; Clyra's cross-platform preview reads these sources.\nimport PackageDescription\nlet package = Package(name: "${identifier}", platforms: [.iOS(.v17)], products: [], targets: [])\n`,
    "App/${identifier}App.swift": `import SwiftUI\n\n@main\nstruct ${identifier}App: App {\n    @StateObject private var store = ${identifier}Store()\n\n    var body: some Scene {\n        WindowGroup {\n            ${identifier}RootView().environmentObject(store)\n        }\n    }\n}\n`,
    "Models/${identifier}Item.swift": `import Foundation\n\nstruct ${identifier}Item: Identifiable, Hashable {\n    let id = UUID()\n    var title: String\n    var detail: String\n    var trailing: String\n}\n\nenum ${identifier}Tab: String, CaseIterable, Identifiable {\n    case ${profile.tabs[0].toLowerCase()}, ${profile.tabs[1].toLowerCase()}, ${profile.tabs[2].toLowerCase()}\n    var id: String { rawValue }\n    var title: String {\n        switch self {\n        ${destinationTitles}\n        }\n    }\n}\n`,
    "ViewModels/${identifier}Store.swift": `import Foundation\n\nfinal class ${identifier}Store: ObservableObject {\n    @Published var items: [${identifier}Item] = [\n${items}\n    ]\n    @Published var selectedTab: ${identifier}Tab = .${profile.tabs[0].toLowerCase()}\n    @Published var showingComposer = false\n    @Published var query = ""\n\n    var filteredItems: [${identifier}Item] {\n        guard !query.isEmpty else { return items }\n        return items.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.detail.localizedCaseInsensitiveContains(query) }\n    }\n\n    func add(title: String, detail: String) {\n        items.insert(${identifier}Item(title: title, detail: detail, trailing: "New"), at: 0)\n    }\n}\n`,
    "Views/${identifier}RootView.swift": `import SwiftUI\n\nstruct ${identifier}RootView: View {\n    @EnvironmentObject private var store: ${identifier}Store\n\n    var body: some View {\n        TabView(selection: $store.selectedTab) {\n            ${identifier}DashboardView().tabItem { Label("${profile.tabs[0]}", systemImage: "square.grid.2x2") }.tag(${identifier}Tab.${profile.tabs[0].toLowerCase()})\n            ${identifier}ListView().tabItem { Label("${profile.tabs[1]}", systemImage: "list.bullet") }.tag(${identifier}Tab.${profile.tabs[1].toLowerCase()})\n            ${identifier}SettingsView().tabItem { Label("${profile.tabs[2]}", systemImage: "slider.horizontal.3") }.tag(${identifier}Tab.${profile.tabs[2].toLowerCase()})\n        }\n        .tint(.blue)\n        .sheet(isPresented: $store.showingComposer) { ${identifier}ComposerView() }\n    }\n}\n`,
    "Views/${identifier}DashboardView.swift": `import SwiftUI\n\nstruct ${identifier}DashboardView: View {\n    @EnvironmentObject private var store: ${identifier}Store\n\n    var body: some View {\n        NavigationStack {\n            ScrollView {\n                VStack(alignment: .leading, spacing: 20) {\n                    VStack(alignment: .leading, spacing: 6) {\n                        Text("${profile.title}").font(.largeTitle.weight(.bold)).tracking(-0.6)\n                        Text("${profile.subtitle}").font(.subheadline).foregroundStyle(.secondary)\n                    }\n                    ${identifier}FeatureSummary()\n                    HStack { Text("Recent").font(.title3.weight(.semibold)); Spacer(); Button("See all") { store.selectedTab = .${profile.tabs[1].toLowerCase()} } }\n                    ${identifier}ItemList(items: store.filteredItems)\n                }.padding(20)\n            }\n            .searchable(text: $store.query, prompt: "Search")\n            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { store.showingComposer = true } label: { Image(systemName: "plus") } } }\n        }\n    }\n}\n\nprivate struct ${identifier}FeatureSummary: View {\n    var body: some View {\n        VStack(alignment: .leading, spacing: 12) {\n            Text("This month").font(.caption.weight(.medium)).foregroundStyle(.secondary)\n            Text("On track").font(.system(size: 30, weight: .bold, design: .rounded))\n            ProgressView(value: 0.68).tint(.blue)\n            Text("68% of your plan is complete").font(.footnote).foregroundStyle(.secondary)\n        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))\n    }\n}\n`,
    "Views/${identifier}Flows.swift": `import SwiftUI\n\nstruct ${identifier}ItemList: View {\n    let items: [${identifier}Item]\n    var body: some View {\n        VStack(spacing: 0) {\n            ForEach(items) { item in\n                NavigationLink { ${identifier}DetailView(item: item) } label: {\n                    HStack(spacing: 12) {\n                        Image(systemName: "circle.inset.filled").foregroundStyle(.blue).font(.title3)\n                        VStack(alignment: .leading, spacing: 3) { Text(item.title).foregroundStyle(.primary); Text(item.detail).font(.footnote).foregroundStyle(.secondary) }\n                        Spacer(); Text(item.trailing).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)\n                    }.padding(.vertical, 12)\n                }\n                if item.id != items.last?.id { Divider() }\n            }\n        }.padding(.horizontal, 14).background(.background, in: RoundedRectangle(cornerRadius: 14, style: .continuous)).overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(.quaternary))\n    }\n}\n\nstruct ${identifier}ListView: View {\n    @EnvironmentObject private var store: ${identifier}Store\n    var body: some View { NavigationStack { List(store.filteredItems) { item in NavigationLink { ${identifier}DetailView(item: item) } label: { VStack(alignment: .leading) { Text(item.title); Text(item.detail).font(.caption).foregroundStyle(.secondary) } } }.navigationTitle("${profile.tabs[1]}").searchable(text: $store.query) } }\n}\n\nstruct ${identifier}DetailView: View {\n    let item: ${identifier}Item\n    var body: some View { Form { Section("Details") { LabeledContent("Name", value: item.title); LabeledContent("Status", value: item.detail); LabeledContent("Value", value: item.trailing) }; Section { Button("Edit") {}.foregroundStyle(.blue); Button("Remove", role: .destructive) {} } }.navigationTitle(item.title).navigationBarTitleDisplayMode(.inline) }\n}\n\nstruct ${identifier}ComposerView: View {\n    @EnvironmentObject private var store: ${identifier}Store\n    @Environment(\\.dismiss) private var dismiss\n    @State private var title = ""\n    @State private var detail = ""\n    var body: some View { NavigationStack { Form { TextField("Title", text: $title); TextField("Details", text: $detail) }.navigationTitle("${profile.primaryAction}").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { store.add(title: title, detail: detail); dismiss() }.disabled(title.trimmingCharacters(in: .whitespaces).isEmpty) } } } }\n}\n\nstruct ${identifier}SettingsView: View {\n    var body: some View { NavigationStack { Form { Section("Preferences") { Toggle("Notifications", isOn: .constant(true)); Toggle("Compact appearance", isOn: .constant(false)) }; Section("About") { LabeledContent("Version", value: "1.0") } }.navigationTitle("${profile.tabs[2]}") } }\n`,
  };
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }));
  // Some older development servers transpiled template-literal object keys
  // literally. Normalize those paths here so the preview always receives a
  // conventional Swift project tree regardless of the dev-server cache.
  const placeholder = "$" + "{identifier}";
  const migrations: Array<[string, string]> = [
    [path.join(root, "App", placeholder + "App.swift"), path.join(root, "App", identifier + "App.swift")],
    [path.join(root, "Models", placeholder + "Item.swift"), path.join(root, "Models", identifier + "Item.swift")],
    [path.join(root, "ViewModels", placeholder + "Store.swift"), path.join(root, "ViewModels", identifier + "Store.swift")],
    [path.join(root, "Views", placeholder + "RootView.swift"), path.join(root, "Views", identifier + "RootView.swift")],
    [path.join(root, "Views", placeholder + "DashboardView.swift"), path.join(root, "Views", identifier + "DashboardView.swift")],
    [path.join(root, "Views", placeholder + "Flows.swift"), path.join(root, "Views", identifier + "Flows.swift")],
  ];
  await Promise.all(migrations.map(async ([legacy, target]) => {
    if (legacy !== target && await fs.stat(legacy).then(() => true).catch(() => false)) await fs.rename(legacy, target);
  }));
  console.info(`[ios-starter] seeded ${profile.kind} source for ${path.basename(root)}`);
  return true;
}

/**
 * A new workspace has no Xcode project yet, so file-based platform detection
 * alone cannot select iOS mode. Seed the same real agent guidance from the
 * request when the user explicitly asks for an Apple-platform project.
 */
async function prepareIosAgentWorkspace(root: string) {
  await fs.writeFile(path.join(root, "AGENTS.md"), IOS_AGENTS_MD, "utf8").catch(() => undefined);
  try {
    await fs.mkdir(path.join(root, ".agent", "skills"), { recursive: true });
    await fs.cp(APPLE_SKILL_SOURCE, path.join(root, ".agent", "skills", "apple-skills"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    await fs.cp(SWIFTUI_SKILL_SOURCE, path.join(root, ".agent", "skills", "swiftui-expert"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  } catch {
    /* Skills are optional context, not a runtime prerequisite. */
  }
}

function sendSse(res: import("express").Response, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** SDK-backed local API. The renderer only sees project/session-scoped data. */
export function registerOpenCodeRoutes(app: Application) {
  app.get("/api/opencode/status", async (_req, res) => {
    const health = await openCodeRuntimeManager.health();
    const configuredModel = codingModelStatus();
    res.json({
      sdkVersion: "1.18.12",
      executableVersion: process.env.CLYRA_OPENCODE_VERSION || "detected at runtime",
      // Model identity is safe to show. Credentials remain exclusively in the
      // service process and are never emitted in this response.
      model: configuredModel.available ? `${configuredModel.providerID}/${configuredModel.modelID}` : undefined,
      providerConfigured: configuredModel.available,
      providerError: configuredModel.available ? undefined : configuredModel.error,
      ...health,
    });
  });

  app.post("/api/opencode/runtime/start", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    try {
      const root = projectPath(projectId);
      await fs.mkdir(root, { recursive: true });
      await ensureProjectGitRepo(root).catch(() => undefined);
      // Seed adaptive agent guidance when missing (OpenCode reads AGENTS.md).
      // iOS projects always get the iOS App Mode guidance plus the Apple
      // development skills copied into the sandbox the agent can read.
      try {
        await fs.access(path.join(root, "AGENTS.md"));
      } catch {
        await fs.writeFile(
          path.join(root, "AGENTS.md"),
          `# Clyra Code Agent

Be an adaptive expert coding agent like Cursor or Codex. Understand intent → investigate → plan across files → act → inspect → adapt → validate until complete.
No fixed tool-call quota. Scale effort to the request. Read before editing. Prefer production-quality work. Fix failures after checks.

Project architecture rules — for every coding request:
- Inspect the existing project structure first (list files, read configs) and match its framework and conventions.
- Split code naturally across components, pages, styles, hooks, utilities, APIs, config, assets, and tests. Never cram everything into a single index.html unless a single-file deliverable is genuinely requested.
- For React/Next/Vite projects create proper files: components, styles, hooks, utilities, routes, and config.
- Reuse existing components instead of rebuilding them. Revisit and edit multiple files during the run when needed.
- Run the project's build/typecheck/tests after changes and fix every error before finishing.
- For greenfield web apps, put index.html at the project root so the live preview can start, and keep it as a thin shell that loads the real source files.
- For desktop/Electron requests, build the product first as a responsive web application that runs in the live development preview. Then add a minimal Electron main/preload wrapper, safe BrowserWindow configuration, and package scripts around that same web app. Do not make the live preview depend on Electron or native-only APIs; it must remain usable in Chromium at every responsive preview size.
`,
          "utf8",
        ).catch(() => undefined);
      }
      // Swift mobile preview mode is source based, not Xcode based.
      if (detectMobileSwiftProject(root)) {
        await prepareIosAgentWorkspace(root);
      }
      res.json(await openCodeRuntimeManager.start(projectId, root));
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "OpenCode could not start." });
    }
  });

  app.post("/api/opencode/runtime/stop", async (_req, res) => {
    await openCodeRuntimeManager.stop();
    res.json({ ok: true });
  });

  app.get("/api/opencode/diagnostic/:projectId", (req, res) => {
    try { res.json(openCodeRuntimeManager.inspect(safeProjectId(req.params.projectId))); }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Project not found." }); }
  });

  app.post("/api/opencode/sessions", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    try { res.json(await openCodeRuntimeManager.createSession(projectId, String(req.body?.title || "").slice(0, 160))); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not create session." }); }
  });

  app.get("/api/opencode/sessions/:projectId", async (req, res) => {
    try { res.json(await openCodeRuntimeManager.listSessions(safeProjectId(req.params.projectId))); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not list sessions." }); }
  });

  app.patch("/api/opencode/sessions/:projectId/:sessionId", async (req, res) => {
    const title = String(req.body?.title || "").trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: "A chat title is required." });
    try { res.json(await openCodeRuntimeManager.renameSession(safeProjectId(req.params.projectId), req.params.sessionId, title)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not rename chat." }); }
  });

  app.delete("/api/opencode/sessions/:projectId/:sessionId", async (req, res) => {
    try {
      await openCodeRuntimeManager.deleteSession(safeProjectId(req.params.projectId), req.params.sessionId);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete chat." }); }
  });

  app.get("/api/opencode/sessions/:projectId/:sessionId/messages", async (req, res) => {
    try { res.json(await openCodeRuntimeManager.messages(safeProjectId(req.params.projectId), req.params.sessionId)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not fetch history." }); }
  });

  app.get("/api/opencode/sessions/:projectId/:sessionId/diff", async (req, res) => {
    try { res.json(await openCodeRuntimeManager.diff(safeProjectId(req.params.projectId), req.params.sessionId)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not fetch changes." }); }
  });

  app.post("/api/opencode/sessions/:projectId/:sessionId/prompt", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text || text.length > MAX_PROMPT_LENGTH) return res.status(400).json({ error: "Enter a coding request up to 20,000 characters." });
    try {
      if (requestsIosProject(text)) {
        const root = projectPath(safeProjectId(req.params.projectId));
        await prepareIosAgentWorkspace(root);
        await seedIosStarterIfEmpty(root, text);
      }
      await openCodeRuntimeManager.prompt(safeProjectId(req.params.projectId), req.params.sessionId, text, typeof req.body?.agent === "string" ? req.body.agent : undefined);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Prompt could not be sent." }); }
  });

  // Persist attachments inside the selected workspace. OpenCode can then read
  // the exact files named in the prompt instead of receiving mock metadata.
  app.post("/api/opencode/projects/:projectId/attachments", async (req, res) => {
    const projectId = safeProjectId(req.params.projectId);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!projectId || !files.length) return res.status(400).json({ error: "Choose one or more files to attach." });
    if (files.length > 12) return res.status(400).json({ error: "Attach up to 12 files at a time." });
    const root = path.join(projectPath(projectId), ".clyra-attachments");
    let total = 0;
    const saved: Array<{ name: string; path: string; type: string }> = [];
    try {
      await fs.mkdir(root, { recursive: true });
      for (const [index, entry] of files.entries()) {
        const encoded = typeof entry?.data === "string" ? entry.data : "";
        const buffer = Buffer.from(encoded, "base64");
        const name = path.basename(String(entry?.name || "attachment")).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120) || "attachment";
        if (!encoded || !buffer.length || buffer.length > MAX_ATTACHMENT_BYTES || total + buffer.length > MAX_ATTACHMENT_TOTAL_BYTES) {
          return res.status(413).json({ error: "Attachments are limited to 6 MB each and 10 MB total." });
        }
        total += buffer.length;
        const filename = `${Date.now()}-${index + 1}-${name}`;
        await fs.writeFile(path.join(root, filename), buffer);
        saved.push({ name, path: `.clyra-attachments/${filename}`, type: String(entry?.type || "application/octet-stream").slice(0, 100) });
      }
      res.json({ attachments: saved });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not attach the selected files." });
    }
  });

  app.post("/api/opencode/sessions/:projectId/:sessionId/abort", async (req, res) => {
    try { await openCodeRuntimeManager.abort(safeProjectId(req.params.projectId), req.params.sessionId); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not abort session." }); }
  });

  app.post("/api/opencode/sessions/:projectId/:sessionId/permissions/:permissionId", async (req, res) => {
    const response = String(req.body?.response || "deny");
    if (!["allow", "always", "deny"].includes(response)) return res.status(400).json({ error: "Invalid permission response." });
    try { await openCodeRuntimeManager.respondPermission(safeProjectId(req.params.projectId), req.params.sessionId, req.params.permissionId, response); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not answer permission." }); }
  });

  app.get("/api/opencode/events/:projectId", (req, res) => {
    const projectId = safeProjectId(req.params.projectId);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    const id = randomUUID();
    try {
      subscriptions.set(id, openCodeRuntimeManager.subscribe(projectId, (event) => sendSse(res, event)));
      req.on("close", () => { subscriptions.get(id)?.(); subscriptions.delete(id); });
    } catch (error) { sendSse(res, { type: "runtime.error", error: error instanceof Error ? error.message : String(error) }); res.end(); }
  });

  // Compatibility endpoint used by the current renderer while it is migrated.
  app.post("/api/opencode/start", async (req, res) => {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return res.status(400).json({ error: "Enter a coding request up to 20,000 characters." });
    const projectId = safeProjectId(String(req.body?.projectId || "")) || `clyra-${randomUUID().slice(0, 8)}`;
    try {
      const root = projectPath(projectId);
      await fs.mkdir(root, { recursive: true });
      await ensureProjectGitRepo(root).catch(() => undefined);
      if (requestsIosProject(prompt)) await prepareIosAgentWorkspace(root);
      await openCodeRuntimeManager.start(projectId, root);
      const session = await openCodeRuntimeManager.createSession(projectId, titleFor(prompt));
      await openCodeRuntimeManager.prompt(projectId, session.id, prompt, Boolean(req.body?.planMode) ? "plan" : undefined);
      res.json({ taskId: session.id, sessionId: session.id, projectId, provider: "opencode-sdk", sdkVersion: "1.18.12" });
    } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "OpenCode could not start." }); }
  });

  app.post("/api/opencode/cancel/:sessionId", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    try { await openCodeRuntimeManager.abort(projectId, req.params.sessionId); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not cancel task." }); }
  });
}
