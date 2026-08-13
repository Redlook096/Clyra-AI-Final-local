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
    if (!compilerUrl) {
      return res.status(503).json({
        error: "Swift/WASM compiler service is not connected. Set CLYRA_SWIFT_WASM_COMPILER_URL to the Linux compiler service.",
      });
    }
    const files = swiftSources(projectRoot(projectId));
    if (!files.some((file) => file.path.endsWith(".swift"))) {
      return res.status(422).json({ error: "Waiting for Swift source files before starting the live preview." });
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
}
