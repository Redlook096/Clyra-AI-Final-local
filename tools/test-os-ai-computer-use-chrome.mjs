import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopControlPath = path.join(root, "scripts", "opencluely-bridge", "desktop-control.service.js");

async function runLiveChromeTest() {
  console.log("[test] Importing desktop control service from bridge...");
  const desktopControl = (await import(`file://${desktopControlPath}`)).default;

  console.log("[test] Initializing desktop control...");
  const init = await desktopControl.initialize();
  console.log("[test] Desktop control initialized:", init);

  if (init.driver === "none") {
    throw new Error("Desktop control driver is unavailable. Enable Accessibility for terminal/Electron.");
  }

  const task = 'Open Google Chrome and type "hello luke it works"';
  console.log(`[test] Starting control session for: "${task}"...`);
  await desktopControl.startControl(task);

  try {
    const appName = process.platform === "darwin" ? "Google Chrome" : "chrome";
    console.log(`[test] 1. Launching ${appName}...`);

    if (process.platform === "darwin") {
      await execFileAsync("open", ["-a", "Google Chrome"]);
    } else if (process.platform === "win32") {
      await execFileAsync("cmd.exe", ["/c", "start", "chrome"]);
    } else {
      await execFileAsync("google-chrome", []);
    }

    console.log("[test] Waiting for Chrome window focus...");
    await wait(1200);

    const focusKey = process.platform === "darwin" ? "cmd+l" : "ctrl+l";
    console.log(`[test] 2. Focusing address bar via key(${focusKey})...`);
    const keyResult = await desktopControl.key(focusKey, "Focus address bar");
    console.log("[test] Key result:", keyResult);

    await wait(300);

    const textToType = "hello luke it works";
    console.log(`[test] 3. Typing text "${textToType}" into address bar...`);
    const typeResult = await desktopControl.typeText(textToType, "Type text");
    console.log("[test] Type result:", typeResult);

    await wait(400);

    console.log("[test] 4. Pressing Enter to confirm search...");
    const enterResult = await desktopControl.key("Return", "Submit search");
    console.log("[test] Enter result:", enterResult);

    console.log("[test] ✅ Live desktop control test completed successfully!");
    return { ok: true, driver: init.driver, typed: textToType };
  } finally {
    console.log("[test] Stopping desktop control session...");
    await desktopControl.stopControl();
  }
}

runLiveChromeTest()
  .then((res) => {
    console.log("[test] SUMMARY:", JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("[test] ❌ Test failed:", err);
    process.exit(1);
  });
