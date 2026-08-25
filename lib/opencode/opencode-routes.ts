import type { Application } from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { clyraDataPath } from "../runtime-paths";
import { codingModelStatus, openCodeRuntimeManager } from "./OpenCodeRuntimeManager";
import { detectMobileSwiftProject } from "../mobile-platform-detect";

const execFileAsync = promisify(execFile);

const IOS_AGENTS_MD = `# Clyra Code Agent — Native SwiftUI Mode

You are building a real Swift/SwiftUI application. Clyra's iPhone panel runs
it on the actual Xcode iOS Simulator (via xcodebuild + xcrun simctl) when the
host Mac has full Xcode installed; on a host without Xcode the panel reports
that plainly instead of pretending a build/run succeeded.

Use the iPhone CLI (node __IPHONE_CLI_PATH__ <command> __PROJECT_ID__ ... —
the CLI reaches Clyra's local server, no separate setup needed) to drive the
same real Simulator your generated app runs in, as part of your own
build/verify loop, not just to show the user something. This project's ID
for these commands is: __PROJECT_ID__
  status                                        — Xcode/arch/device availability
  devices                                        — list Simulator devices
  run <projectId> [deviceId]                     — boot + build + install + launch + start stream
  rebuild <projectId>                            — rebuild + reinstall + relaunch after an edit
  ui <projectId>                                 — read the real accessibility tree (JSON)
  tap <projectId> <x0..1> <y0..1>                — tap a point (normalized screen coords)
  swipe <projectId> <up|down|left|right>
  type <projectId> <text>
  home <projectId>                               — press the Home button
  rotate <projectId> <portrait|landscape>
  screenshot <projectId> <outputPath>
  logs <projectId>                                — recent simulator/app log lines

Never claim a build, install, launch, or interaction succeeded unless the CLI
actually returned ok:true for it. A successful xcodebuild is not "done" —
after installing and launching, read the accessibility tree or a screenshot
and confirm the screen you expect is actually showing before reporting
completion. If \`status\` reports no Xcode/no devices, say so plainly and keep
working on the source; do not fabricate a run you could not perform.

Project architecture rules — for every coding request:
- Inspect the existing project structure first (list files and read Package.swift) and match its conventions.
- Split code across the standard layout — never generate the whole application inside one giant Swift file:
  App/  Views/  Components/  Models/  ViewModels/  Services/  Utilities/  Resources/  Tests/
- Use real SwiftUI and a portable Swift Package (Package.swift). Keep views small, focused and reusable.
- Reuse existing views and models instead of rebuilding them. Revisit and edit multiple files during the run when needed.
- Apple guidance lives in .agent/skills/ — consult the bundled Apple Skills, Claude Code Apple Skills, SwiftUI expert guidance, **ios-swiftui/SKILL.md**, **ios-design/SKILL.md**, and **swiftui-design-skill/SKILL.md** before designing an iOS interface. Use its anti-template review and app-specific visual direction, not a generic starter layout.
- The real Simulator run can be unavailable on a host without full Xcode (check with the CLI's \`status\` command). Generate correct, real Swift/SwiftUI source regardless; report the run limitation plainly rather than claiming a build/install/launch you could not perform.
- Only claim completion for checks that actually ran. If validation fails, show the error, fix the file, and rerun the available validation.
- Use SF Symbols, Swift concurrency (async/await), and accessibility best practices.

Product and quality loop — adapt depth to the requested product before editing:
- Work through understand → inspect → product/UX plan → visual system → architecture → implement → validate → preview → critique → refine. Use the real todo tool for non-trivial work and revisit earlier phases when the result is weak.
- Infer the product's users, core job, primary flows, screen inventory, navigation and data states. Do not reuse a generic dashboard, a fixed tab bar, a hero card, or a four-card grid across unrelated products.
- Select an app-specific design direction (for example: calm editorial journaling, dense finance utility, media-first travel, focused professional tool). Establish a restrained type scale, 4/8/12/16/20/24/32 spacing rhythm, compact radii, surface hierarchy and action hierarchy before implementing views.
- Avoid generic template signals: inflated cards, giant pills, gradients, glowing surfaces, decorative sparkles, meaningless metrics, oversized headings, repeated tiles and dead controls. Use spacing, typography, grouped lists, separators and purposeful content to create hierarchy instead.
- Build complete flows, not only a polished home screen: include appropriate empty, populated, loading, error, edit, confirmation and settings states. Every visible action must have a real SwiftUI destination or behaviour.
- Use believable product-specific sample content so the preview can be judged. Keep state, navigation and persistence appropriate to the scope; never hard-code a complex product into one view.
- For apps that need primary destinations, prefer the provided FloatingTabBar component: a restrained floating, translucent bottom navigation material that lets content scroll beneath it, uses safe-area spacing, and can gently recede while content is being read. Do not use it for every app; choose navigation based on the product.
- Before completion, run a real visual and interaction review in the available live preview: exercise navigation, primary actions, editing, cancellation, destructive actions and dynamic data. Repair clipping, weak hierarchy, inaccessible contrast, oversized controls, dead interactions or generic composition before finalising.
- Test compact, standard and large iPhone layouts conceptually in SwiftUI with safe areas and Dynamic Type in mind. Use meaningful accessibility labels and touch targets.
- The browser/preview tool is a real verification tool. When browser mode is requested, observe the active preview, interact with it, verify outcomes, repair source where necessary and re-test. Never claim interactions that did not occur.

Execution discipline:
- Read swiftui-design-skill/SKILL.md plus only the references directly relevant to this app, then begin implementation immediately. Do not inspect the host filesystem outside the project or shell/environment configuration beyond running the iPhone CLI's \`status\`/\`run\`/\`ui\` commands as documented above; this is a local source/build workspace, not an open-ended environment-diagnosis task.
- After Package.swift and the existing views are known, make the first meaningful product edit within the next three tool calls. Keep working in focused multi-file edits rather than repeatedly listing files.
- The generated starter is a previewable baseline only. Adapt it to the requested app and create real task-specific changes before completion; never report it as the finished product unchanged.

Definition of done for an advanced iOS product:
- First create a compact internal product brief: user, primary job, primary flow, screen inventory, navigation choice, data model and design direction. Use this to drive implementation rather than inventing a generic dashboard.
- For a medium or advanced product, implement a minimum of four genuinely useful screens or states, at least three reusable components, a domain model, observable app state and believable populated sample data. The home screen alone is never enough.
- Wire every visible primary action to a real SwiftUI behaviour: navigation, edit/create flow, filtering, selection, sheet, alert, persistence mutation, or an explicit disabled/unavailable state with a reason. Do not leave decorative buttons.
- Build a stateful app: mutations must visibly update the appropriate screen and survive view refreshes when the scope calls for it. Prefer AppStorage/UserDefaults for small local persistence rather than fake static controls.
- Before finishing, inspect the complete app as a product designer. Remove repeated large cards, unused navigation destinations, placeholder labels, empty metric blocks, excessive rounded surfaces and controls that do not match the product's job. If the first version looks like a template, revise it before validating.
- Keep completion claims honest: only report a build/install/launch/interaction as done when the iPhone CLI actually returned ok:true for it, and confirm the resulting screen via the accessibility tree or a screenshot rather than assuming the last edit worked.
`;

const APPLE_SKILL_SOURCE = path.resolve(process.cwd(), "lib/apple-skills-repo", "skills");
const CLAUDE_APPLE_SKILL_SOURCE = path.resolve(process.cwd(), "lib/claude-code-apple-skills", "skills");
const SWIFTUI_SKILL_SOURCE = path.resolve(process.cwd(), "lib/swiftui-agent-skill-repo", "skills", "swiftui-expert-skill");
const SWIFTUI_DESIGN_SKILL_SOURCE = path.resolve(process.cwd(), "lib/swiftui-design-skill");
const IOS_SWIFTUI_SKILL_SOURCE = path.resolve(process.cwd(), "skills", "ios-swiftui");
const IOS_DESIGN_SKILL_SOURCE = path.resolve(process.cwd(), "skills", "ios-design");

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
  return /\b(?:ios|iphone|ipad|swiftui|uikit|xcode|xcworkspace|xcodeproj|watchos|visionos|apple\s+watch|apple\s+tv|tvos|app\s+store)\b/i.test(prompt);
}

type IosStarterProfile = {
  title: string;
  kind: "finance" | "travel" | "health" | "food" | "productivity";
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
  const named = (explicitName || buildName)?.replace(/\s+(?:for|with|a|an|the)\b.*$/i, "").trim();
  if (/travel|trip|itinerary|flight|hotel|destination|journey/.test(text)) return {
    title: named || "Wayfinder", kind: "travel", subtitle: /japan|tokyo|kyoto|osaka/.test(text) ? "Japan, one considered day at a time" : "Plans that leave room for discovery", primaryAction: "Add to itinerary",
    tabs: ["Explore", "Itinerary", "Saved"],
    items: /japan|tokyo|kyoto|osaka/.test(text)
      ? [{ name: "Shinkansen to Kyoto", detail: "Day 4 · 9:12 AM · Reserved", amount: "›" }, { name: "Kiyomizu-dera at sunrise", detail: "Day 5 · Saved place", amount: "›" }, { name: "Nishiki Market tasting walk", detail: "Day 5 · 12:30 PM", amount: "›" }]
      : [{ name: "Alfama morning walk", detail: "Day 2 · 9:30 AM", amount: "›" }, { name: "Tasca da Sé", detail: "Dinner · Reservation saved", amount: "›" }, { name: "Belém train", detail: "Day 3 · 10:10 AM", amount: "›" }],
  };
  if (/budget|finance|money|expense|transaction|account/.test(text)) return {
    title: named || "Ledgerly", kind: "finance", subtitle: "A clearer view of every dollar", primaryAction: "Add transaction",
    tabs: ["Overview", "Activity", "Plan"],
    items: [{ name: "Northstar Card", detail: "Balance · updated today", amount: "$3,842" }, { name: "Weekly groceries", detail: "Food & dining · Today", amount: "−$68" }, { name: "Transit pass", detail: "Transport · Yesterday", amount: "−$42" }],
  };
  if (/health|medication|wellness|habit|symptom|workout|fitness/.test(text)) return {
    title: named || "Morrow", kind: "health", subtitle: "Small routines, clearly understood", primaryAction: "Log progress",
    tabs: ["Today", "Insights", "Profile"],
    items: [{ name: "Morning medication", detail: "8:00 AM · Due now", amount: "Start" }, { name: "Hydration", detail: "4 of 8 glasses", amount: "50%" }, { name: "Evening reflection", detail: "8:30 PM · Scheduled", amount: "›" }],
  };
  if (/meal|recipe|grocery|grocer|food|cook|cooking|nutrition|restaurant|kitchen/.test(text)) return {
    title: named || "Table", kind: "food", subtitle: "Thoughtful meals, one week at a time", primaryAction: "Add meal",
    tabs: ["Today", "Plan", "List"],
    items: [{ name: "Miso salmon bowls", detail: "Tuesday dinner · 30 min", amount: "›" }, { name: "Market vegetables", detail: "Shopping list · 7 items", amount: "7" }, { name: "Lemon ricotta pasta", detail: "Friday dinner · Saved", amount: "›" }],
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
    "Views/${identifier}RootView.swift": `import SwiftUI\n\nstruct ${identifier}RootView: View {\n    @EnvironmentObject private var store: ${identifier}Store\n\n    var body: some View {\n        ZStack(alignment: .bottom) {\n            Group {\n                switch store.selectedTab {\n                case .${profile.tabs[0].toLowerCase()}: ${identifier}DashboardView()\n                case .${profile.tabs[1].toLowerCase()}: ${identifier}ListView()\n                case .${profile.tabs[2].toLowerCase()}: ${identifier}SettingsView()\n                }\n            }\n            .frame(maxWidth: .infinity, maxHeight: .infinity)\n\n            ${identifier}FloatingTabBar(selection: $store.selectedTab)\n                .padding(.horizontal, 16)\n                .padding(.bottom, 8)\n        }\n        .tint(.blue)\n        .sheet(isPresented: $store.showingComposer) { ${identifier}ComposerView() }\n    }\n}\n`,
    "Components/${identifier}FloatingTabBar.swift": `import SwiftUI\n\n/// A quiet floating navigation material. Content remains visible behind it;\n/// callers can hide it during immersive flows rather than adding another bar.\nstruct ${identifier}FloatingTabBar: View {\n    @Binding var selection: ${identifier}Tab\n\n    private let items: [(tab: ${identifier}Tab, title: String, icon: String)] = [\n        (.${profile.tabs[0].toLowerCase()}, "${profile.tabs[0]}", "square.grid.2x2"),\n        (.${profile.tabs[1].toLowerCase()}, "${profile.tabs[1]}", "list.bullet"),\n        (.${profile.tabs[2].toLowerCase()}, "${profile.tabs[2]}", "slider.horizontal.3")\n    ]\n\n    var body: some View {\n        HStack(spacing: 4) {\n            ForEach(Array(items.enumerated()), id: \\.offset) { _, item in\n                Button { withAnimation(.snappy(duration: 0.24)) { selection = item.tab } } label: {\n                    Label(item.title, systemImage: item.icon)\n                        .font(.footnote.weight(selection == item.tab ? .semibold : .regular))\n                        .foregroundStyle(selection == item.tab ? Color.primary : Color.secondary)\n                        .frame(maxWidth: .infinity)\n                        .padding(.vertical, 10)\n                        .contentShape(Rectangle())\n                }\n                .buttonStyle(.plain)\n                .accessibilityAddTraits(selection == item.tab ? .isSelected : [])\n            }\n        }\n        .padding(5)\n        .background(.ultraThinMaterial, in: Capsule(style: .continuous))\n        .overlay(Capsule(style: .continuous).stroke(.white.opacity(0.45), lineWidth: 0.7))\n        .shadow(color: .black.opacity(0.10), radius: 12, y: 5)\n        .accessibilityElement(children: .contain)\n    }\n}\n`,
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
async function prepareIosAgentWorkspace(root: string, projectId: string) {
  const cliPath = path.resolve(process.cwd(), "tools", "clyra-iphone-cli.cjs");
  const agentsMd = IOS_AGENTS_MD.replaceAll("__IPHONE_CLI_PATH__", cliPath).replaceAll("__PROJECT_ID__", projectId);
  await fs.writeFile(path.join(root, "AGENTS.md"), agentsMd, "utf8").catch(() => undefined);
  try {
    await fs.mkdir(path.join(root, ".agent", "skills"), { recursive: true });
    await fs.cp(APPLE_SKILL_SOURCE, path.join(root, ".agent", "skills", "apple-skills"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    // This MIT-licensed skill library gives iOS runs the additional product,
    // SwiftUI, design, testing, accessibility and release-review guidance.
    // It is copied into the selected workspace only; the renderer never sees
    // a private credential or a host-specific Apple toolchain.
    await fs.cp(CLAUDE_APPLE_SKILL_SOURCE, path.join(root, ".agent", "skills", "claude-code-apple-skills"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    await fs.cp(SWIFTUI_SKILL_SOURCE, path.join(root, ".agent", "skills", "swiftui-expert"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    // Copy the runnable skill payload explicitly rather than copying the
    // repository directory.  `fs.cp` can silently skip a nested git worktree
    // on some hosts; that previously left an iOS agent with a prompt pointing
    // at a missing SKILL.md.
    const destination = path.join(root, ".agent", "skills", "swiftui-design-skill");
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(path.join(SWIFTUI_DESIGN_SKILL_SOURCE, "SKILL.md"), path.join(destination, "SKILL.md"));
    for (const directory of ["references", "templates"]) {
      const source = path.join(SWIFTUI_DESIGN_SKILL_SOURCE, directory);
      const exists = await fs.stat(source).then(() => true).catch(() => false);
      if (exists) await fs.cp(source, path.join(destination, directory), { recursive: true, force: true });
    }
    // Native SwiftUI coding + Apple HIG design skills — the router always loads
    // these for iOS requests so generated apps are real Swift/SwiftUI following
    // Apple conventions rather than HTML/CSS styled to look like an iPhone.
    await fs.cp(IOS_SWIFTUI_SKILL_SOURCE, path.join(root, ".agent", "skills", "ios-swiftui"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    await fs.cp(IOS_DESIGN_SKILL_SOURCE, path.join(root, ".agent", "skills", "ios-design"), {
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

Research-before-build policy:
- When a request names or links a current public product, website, framework, library, API, repository, brand, or versioned design system, research authoritative public sources before implementation. Prefer the official site, docs, organisation/repository and release notes; do not build from stale memory or random screenshots.
- Then inspect this project, plan the adaptation, implement, run the relevant checks, open the preview, compare and correct visible issues. Keep research out of simple local refactors where external context adds no value.

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
      // Real Xcode Simulator when the Apple Host has Xcode; the CLI in
      // IOS_AGENTS_MD tells the agent honestly when it does not.
      if (detectMobileSwiftProject(root)) {
        await prepareIosAgentWorkspace(root, projectId);
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
    const projectId = safeProjectId(req.params.projectId);
    try { res.json(await openCodeRuntimeManager.listSessions(projectId, projectPath(projectId))); }
    catch { res.json([]); }
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
        await prepareIosAgentWorkspace(root, safeProjectId(req.params.projectId));
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
      if (requestsIosProject(prompt)) await prepareIosAgentWorkspace(root, projectId);
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
