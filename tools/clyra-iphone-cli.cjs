#!/usr/bin/env node
/**
 * Agent-facing CLI onto Clyra's iPhone system (lib/iphone/iphone-routes.ts).
 * The coding agent runs inside the project workspace and only has a shell —
 * this script is how it drives the real Xcode Simulator during its own
 * build/verify loop (boot, build, install, launch, tap, type, screenshot,
 * accessibility tree, logs), the same REST surface the Clyra iPhone panel
 * itself uses, over the same local server the agent's Vibe Coder session is
 * already running against.
 *
 * Usage: node clyra-iphone-cli.cjs <command> [args...]
 *   status
 *   devices
 *   run <projectId> [deviceId]
 *   rebuild <projectId>
 *   relaunch <projectId>
 *   tap <projectId> <x0..1> <y0..1>
 *   swipe <projectId> <up|down|left|right>
 *   type <projectId> <text>
 *   home <projectId>
 *   rotate <projectId> <portrait|landscape>
 *   ui <projectId>            (accessibility tree)
 *   screenshot <projectId> <outputPath>
 *   logs <projectId>
 *   stop <projectId>
 */
const BASE = process.env.CLYRA_SERVER_URL || "http://127.0.0.1:3000";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `${path} failed (${res.status})`);
    return json;
  }
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  switch (command) {
    case "status":
      result = await call("GET", "/api/iphone/status");
      break;
    case "devices":
      result = await call("GET", "/api/iphone/devices");
      break;
    case "run":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/run`, args[1] ? { deviceId: args[1] } : {});
      break;
    case "rebuild":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/rebuild`);
      break;
    case "relaunch":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/relaunch`);
      break;
    case "tap":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "tap", x: Number(args[1]), y: Number(args[2]) });
      break;
    case "swipe":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "swipe", direction: args[1] });
      break;
    case "type":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "type", text: args.slice(1).join(" ") });
      break;
    case "home":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "home" });
      break;
    case "rotate":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "rotate", orientation: args[1] || "landscape" });
      break;
    case "ui":
      result = await call("GET", `/api/iphone/projects/${encodeURIComponent(args[0])}/accessibility`);
      break;
    case "screenshot": {
      const png = await call("GET", `/api/iphone/projects/${encodeURIComponent(args[0])}/screenshot`);
      const fs = require("node:fs");
      fs.writeFileSync(args[1] || "screenshot.png", png);
      result = { ok: true, path: args[1] || "screenshot.png" };
      break;
    }
    case "logs":
      result = await call("GET", `/api/iphone/projects/${encodeURIComponent(args[0])}/logs`);
      break;
    case "stop":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/stop`);
      break;
    case "terminate":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/terminate`);
      break;
    case "reload":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/relaunch`);
      break;
    case "longpress":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "longpress", x: Number(args[1]), y: Number(args[2]), seconds: args[3] ? Number(args[3]) : undefined });
      break;
    case "scroll":
      result = await call("POST", `/api/iphone/projects/${encodeURIComponent(args[0])}/control`, { action: "scroll", direction: args[1] });
      break;
    case "health":
      result = await call("GET", "/api/iphone/status");
      break;
    case "setup":
      result = await call("GET", "/api/iphone/setup/diagnose");
      break;
    case "find": {
      const tree = await call("GET", `/api/iphone/projects/${encodeURIComponent(args[0])}/accessibility`);
      const query = (args[1] || "").toLowerCase();
      const matches = (tree.root?.children || []).filter((el) => (el.label || "").toLowerCase().includes(query));
      result = { ok: true, matches };
      break;
    }
    case "hosts":
      // Saved paired Mac hosts — only meaningful when this Clyra instance is
      // itself the connecting (Windows) side; on macOS local mode there is
      // nothing to list here, the Mac IS the host.
      result = { ok: true, hosts: [], note: "This machine runs the local Apple Host directly; saved remote hosts apply on the connecting (e.g. Windows) side." };
      break;
    case "connect-host":
      result = { ok: false, error: "connectHost is a client-side (Windows) operation — not applicable when Clyra is already the local Apple Host." };
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
