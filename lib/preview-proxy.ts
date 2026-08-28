/**
 * Preview proxy + Visual Edit source synchronization.
 *
 * The project preview runs on its own vite port (cross-origin iframe), which
 * blocks DOM inspection. This module proxies the preview through the local
 * Clyra origin so the inspect overlay can read the real DOM, and exposes the
 * source-edit endpoint that writes visual changes back into the project's
 * actual files.
 */
import type { Application } from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { WebSocket } from "ws";
import { getPreviewTargetPort } from "./vibe-coder/preview/preview-runner";
import { clyraDataPath } from "./runtime-paths";

const INSPECT_SCRIPT = fs.readFileSync(
  path.resolve(process.cwd(), "lib/vibe-coder/preview/clyra-inspect.js"),
  "utf8",
);

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function projectFilesRoot(projectId: string) {
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

function isHtmlContentType(type: string | undefined) {
  return Boolean(type && /text\/html/.test(type));
}

/** Strip hop-by-hop headers before relaying a proxied response. */
function relayHeaders(headers: http.IncomingHttpHeaders) {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    if (["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length"].includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** Forward one HTTP request to the given target, optionally rewriting HTML. */
function proxyRequest(
  req: Parameters<Parameters<Application["use"]>[1]>[0],
  res: Parameters<Parameters<Application["use"]>[1]>[1],
  targetPort: number,
  options?: { inject?: boolean; injectScript?: string },
) {
  const targetHost = "127.0.0.1";
  const upstreamReq = http.request(
    {
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
    },
    (upstream) => {
      const contentType = String(upstream.headers["content-type"] ?? "");
      const status = upstream.statusCode ?? 502;
      if (options?.inject && isHtmlContentType(contentType)) {
        // The page is rewritten below, so relay every safe header except the
        // upstream content length. Passing `undefined` to writeHead crashes
        // Node 24 instead of removing the header.
        res.writeHead(status, relayHeaders(upstream.headers));
        let chunks = "";
        upstream.setEncoding("utf8");
        upstream.on("data", (chunk) => {
          chunks += chunk;
        });
        upstream.on("end", () => {
          let html = chunks;
          // Rewrite absolute asset references into the proxied namespace so
          // /@vite/client and /src/... resolve through this origin.
          html = html.replace(/(src|href)="\/(?!\/)/g, `$1="/api/vibe/projects/${safeProjectId(String((req.params as { projectId?: string })?.projectId ?? ""))}/preview/`);
          // Inline the small local overlay bridge. Some embedded preview
          // environments block an extra injected script request even when
          // ordinary project scripts are allowed; inline execution keeps the
          // bridge deterministic without granting it any new capabilities.
          const inject = options.inject ? `<script>${INSPECT_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>` : "";
          if (inject && !html.includes("window.__clyraInspect")) {
            html = html.replace(/<\/head>/i, `${inject}</head>`);
          }
          res.end(html);
        });
        upstream.on("error", () => res.end());
        return;
      }
      res.writeHead(status, relayHeaders(upstream.headers));
      upstream.pipe(res);
    },
  );
  upstreamReq.on("error", (error) => {
    if (!res.headersSent) res.status(502).json({ error: `Preview unavailable: ${error.message}` });
    else res.end();
  });
  req.pipe(upstreamReq);
}

/** Proxy a websocket upgrade to the given target port. */
export function proxyUpgrade(req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, targetPort: number) {
  const { WebSocketServer } = require("ws") as typeof import("ws");
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url}`, {
      headers: { "sec-websocket-protocol": (client as unknown as { protocol?: string }).protocol ?? "" },
    });
    let ready = false;
    const queue: Buffer[] = [];
    client.on("message", (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (ready) upstream.send(buffer);
      else queue.push(buffer);
    });
    upstream.on("open", () => {
      ready = true;
      for (const data of queue) upstream.send(data);
      queue.length = 0;
    });
    upstream.on("message", (data) => client.send(data));
    upstream.on("close", () => client.close());
    client.on("close", () => upstream.close());
    upstream.on("error", () => client.close());
    client.on("error", () => upstream.close());
  });
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
}

/** Textual, real-source CSS edit: replace or add one declaration in a rule. */
export function applyCssSourceEdit(root: string, file: string, selector: string, property: string, value: string) {
  // Preview style sheets commonly report root-relative paths (for example
  // `/src/styles.css`). Keep those inside the selected project rather than
  // letting path.resolve treat them as machine-absolute paths.
  const safeFile = path
    .normalize(file)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const absolute = path.resolve(root, safeFile);
  if (!absolute.startsWith(path.resolve(root) + path.sep) && absolute !== path.resolve(root)) {
    throw new Error("Path is outside the project.");
  }
  if (!/\.(?:css|scss|sass|less)$/i.test(safeFile)) {
    throw new Error("Visual CSS edits can only be written to a stylesheet. Use the agent for component or SwiftUI changes.");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(property)) {
    throw new Error("Unsupported CSS property.");
  }
  const original = fs.readFileSync(absolute, "utf8");
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rulePattern = new RegExp(`(${escapedSelector}\\s*\\{)([\\s\\S]*?)(\\})`, "g");
  const propPattern = new RegExp(`(^|;\\s*)${property}\\s*:[^;]*;?`, "g");
  const hadProperty = propPattern.test(original);
  propPattern.lastIndex = 0;
  let applied = false;
  let next = original.replace(rulePattern, (_match, open: string, body: string, close: string) => {
    if (propPattern.test(body)) {
      applied = true;
      propPattern.lastIndex = 0;
      return `${open}${body.replace(propPattern, `$1${property}: ${value};`)}${close}`;
    }
    applied = true;
    return `${open}${body.replace(/\s*$/, "")}\n  ${property}: ${value};\n${close}`;
  });
  if (!applied) {
    // No existing rule: append one at the end of the file.
    next = `${original.replace(/\s*$/, "")}\n\n${selector} {\n  ${property}: ${value};\n}\n`;
  }
  if (next !== original) {
    fs.writeFileSync(absolute, next, "utf8");
    return {
      applied: true,
      file: safeFile,
      selector,
      property,
      value,
      before: original,
      after: next,
      additions: 1,
      deletions: hadProperty ? 1 : 0,
    };
  }
  return { applied: false };
}

export function registerPreviewProxy(app: Application) {
  // Visual Edit source synchronization (real file writes).
  app.post("/api/vibe/projects/:projectId/source-edit", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const file = String(req.body?.file ?? "");
    const selector = String(req.body?.selector ?? "").trim();
    const property = String(req.body?.property ?? "").trim();
    const value = String(req.body?.value ?? "").trim();
    if (!projectId || !file || !selector || !property) {
      res.status(400).json({ error: "file, selector, property and value are required." });
      return;
    }
    try {
      const result = applyCssSourceEdit(projectFilesRoot(projectId), file, selector, property, value);
      res.json(result);
    } catch (error) {
      res.status(422).json({ applied: false, error: error instanceof Error ? error.message : "Source edit failed." });
    }
  });

  // Preview proxy with the inspect script injected.
  app.use("/api/vibe/projects/:projectId/preview", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (req.url === "/clyra-preview-overlay.js" || req.url === "clyra-preview-overlay.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(INSPECT_SCRIPT);
      return;
    }
    const port = getPreviewTargetPort(projectId);
    if (!port) {
      res.status(502).json({ error: "The preview server is not running yet." });
      return;
    }
    proxyRequest(req as never, res as never, port, {
      inject: true,
      injectScript: "inline",
    });
  });

}
