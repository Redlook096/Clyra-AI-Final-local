#!/usr/bin/env node
/**
 * Deterministic iPhone Simulator E2E harness. No AI model, no API credits —
 * every step here calls the real /api/iphone/* routes (lib/iphone/iphone-routes.ts),
 * which call the real IPhoneProvider (SimctlProvider today). Nothing is
 * mocked: if a real Simulator can't be reached, the corresponding step is
 * recorded as BLOCKED with the real error, never faked as passing.
 *
 * Usage:
 *   node tools/iphone-e2e.mjs mac        (npm run test:iphone:mac-e2e)
 *   node tools/iphone-e2e.mjs windows    (npm run test:iphone:windows-e2e)
 *   node tools/iphone-e2e.mjs            (npm run test:iphone:real — alias for mac)
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLYRA_SERVER_URL || "http://127.0.0.1:3000";
const mode = process.argv[2] || "mac";
const outDir = path.resolve(process.cwd(), "iphone-e2e-evidence");
fs.mkdirSync(outDir, { recursive: true });

const steps = [];
function record(name, status, detail) {
  const entry = { name, status, detail, timestamp: new Date().toISOString() };
  steps.push(entry);
  const icon = status === "PASS" ? "✓" : status === "BLOCKED" ? "○" : "✗";
  console.log(`${icon} ${name}: ${status}${detail ? " — " + summarize(detail) : ""}`);
  return entry;
}
function summarize(detail) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  console.log(`\nClyra iPhone E2E — mode: ${mode}, clientOS: ${process.platform}\n`);

  const capabilities = await get("/api/iphone/capabilities");
  fs.writeFileSync(path.join(outDir, "host-capabilities.json"), JSON.stringify(capabilities.body, null, 2));
  record("host.capabilities", capabilities.ok ? "PASS" : "FAIL", capabilities.body);

  const diagnose = await get("/api/iphone/setup/diagnose");
  fs.writeFileSync(path.join(outDir, "xcode-diagnostics.json"), JSON.stringify(diagnose.body, null, 2));
  record("xcode.diagnose", diagnose.ok ? "PASS" : "FAIL", diagnose.body);

  const recommended = await get("/api/iphone/setup/recommended-xcode");
  fs.writeFileSync(path.join(outDir, "xcode-compatibility.json"), JSON.stringify(recommended.body, null, 2));
  record("xcode.compatibility-resolver", recommended.ok ? "PASS" : "FAIL", recommended.body);

  const devices = await get("/api/iphone/devices");
  fs.writeFileSync(path.join(outDir, "runtime-diagnostics.json"), JSON.stringify(devices.body, null, 2));
  const bootedDevice = (devices.body.devices || []).find((d) => d.state === "Booted");

  if (diagnose.body.state !== "READY") {
    record("simulator.boot", "BLOCKED", `Apple Host state is ${diagnose.body.state}, not READY — ${diagnose.body.message}`);
    for (const name of [
      "simulator.springboard", "ui.semantic-snapshot", "flow.home", "flow.settings", "flow.general", "flow.about",
      "flow.scroll", "flow.system-app-discovery", "flow.system-app-open", "flow.text-input", "flow.text-edit",
      "flow.swipe", "flow.rotate-landscape", "flow.rotate-portrait", "flow.lock", "flow.screenshot",
      "flow.app-switch-cycles", "soak.10min", "reconnect.renderer-reload", "reconnect.clyra-restart", "reconnect.apple-host-restart",
    ]) {
      record(name, "BLOCKED", "No real Simulator is reachable on this Apple Host — see xcode.diagnose above for the exact reason.");
    }
  } else if (!bootedDevice) {
    record("simulator.boot", "BLOCKED", "Xcode is READY but no simulator is currently booted for this harness to attach to.");
  } else {
    record("simulator.boot", "PASS", bootedDevice);
    // A booted device exists — from here on, real interactive checks would
    // run against session state that a live project's iPhone panel owns
    // (lib/iphone/iphone-routes.ts's per-project `sessions` map), which this
    // standalone script does not create. Wiring a project-less direct-device
    // QA path is future work; recorded honestly rather than assumed.
    record("simulator.interactive-flows", "BLOCKED", "A device is booted, but this harness has no bound project/session to drive iphone.tap/type/etc. through — run via the Clyra iPhone panel instead.");
  }

  if (mode === "windows") {
    const remoteFileCheck = fs.existsSync(path.resolve(process.cwd(), "lib/iphone/remote/AppleHostServer.ts"));
    record("windows.remote-protocol-present", remoteFileCheck ? "PASS" : "FAIL");
    record("windows.physical-e2e", "NOT_RUN", "No Windows hardware available in this environment — this script is ready to run there unmodified.");
  }

  const report = {
    mode,
    clientOS: process.platform,
    ranAt: new Date().toISOString(),
    usedAiApi: false,
    steps,
    summary: {
      pass: steps.filter((s) => s.status === "PASS").length,
      blocked: steps.filter((s) => s.status === "BLOCKED").length,
      fail: steps.filter((s) => s.status === "FAIL").length,
      notRun: steps.filter((s) => s.status === "NOT_RUN").length,
    },
  };
  fs.writeFileSync(path.join(outDir, "iphone-e2e-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nSummary: ${report.summary.pass} PASS / ${report.summary.blocked} BLOCKED / ${report.summary.fail} FAIL / ${report.summary.notRun} NOT_RUN`);
  console.log(`Evidence written to ${outDir}`);
  process.exitCode = report.summary.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("E2E harness crashed:", error);
  process.exitCode = 1;
});
