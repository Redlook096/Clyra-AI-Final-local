import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopControlPath = path.join(root, "scripts", "opencluely-bridge", "desktop-control.service.js");

async function runLongChromeTaskTest() {
  console.log("==========================================================");
  console.log("   LIVE BACKEND TEST: os-ai-computer-use LONG CHROME TASK ");
  console.log("==========================================================");

  console.log("[test] 1. Importing desktop control service from bridge...");
  const desktopControl = (await import(`file://${desktopControlPath}`)).default;

  console.log("[test] 2. Initializing desktop control...");
  const init = await desktopControl.initialize();
  console.log("[test] Desktop control initialized:", init);

  if (init.driver === "none") {
    throw new Error("Desktop control driver unavailable. Grant Accessibility permissions.");
  }

  const task = 'Open Google Chrome, navigate to wikipedia.org, search for Artificial Intelligence, and scroll the page';
  console.log(`[test] 3. Starting Take Control session for task: "${task}"...`);
  await desktopControl.startControl(task);

  const stepsCompleted = [];

  try {
    // Step 1: Open Google Chrome
    const appName = process.platform === "darwin" ? "Google Chrome" : "chrome";
    console.log(`[test-step 1/5] Opening ${appName}...`);
    if (process.platform === "darwin") {
      await execFileAsync("open", ["-a", "Google Chrome"]);
    } else if (process.platform === "win32") {
      await execFileAsync("cmd.exe", ["/c", "start", "chrome"]);
    } else {
      await execFileAsync("google-chrome", []);
    }
    stepsCompleted.push("Open Google Chrome");
    await wait(1500);

    // Step 2: Focus address bar and navigate to wikipedia.org
    const focusKey = process.platform === "darwin" ? "cmd+l" : "ctrl+l";
    console.log(`[test-step 2/5] Focusing address bar via ${focusKey} and navigating to wikipedia.org...`);
    await desktopControl.key(focusKey, "Focus address bar");
    await wait(250);
    await desktopControl.typeText("https://wikipedia.org", "Type Wikipedia URL");
    await wait(300);
    await desktopControl.key("Return", "Navigate");
    stepsCompleted.push("Navigate to wikipedia.org");
    await wait(2000);

    // Step 3: Type search query "Artificial Intelligence" into Wikipedia search
    console.log('[test-step 3/5] Typing search query "Artificial Intelligence"...');
    await desktopControl.typeText("Artificial Intelligence", "Type search query");
    await wait(400);
    stepsCompleted.push('Type query "Artificial Intelligence"');

    // Step 4: Submit search via Enter key
    console.log("[test-step 4/5] Pressing Enter to execute Wikipedia search...");
    await desktopControl.key("Return", "Submit Wikipedia search");
    stepsCompleted.push("Submit Wikipedia search");
    await wait(2500);

    // Step 5: Perform page scroll to read content
    console.log("[test-step 5/5] Scrolling down page to view Wikipedia results...");
    await desktopControl.scroll(-6, "Scroll Wikipedia article down");
    await wait(1000);
    await desktopControl.scroll(-6, "Scroll further down");
    stepsCompleted.push("Scroll Wikipedia article content");

    console.log("==========================================================");
    console.log(" ✅ LONG CHROME BACKEND TASK TEST COMPLETED SUCCESSFULLY! ");
    console.log("==========================================================");

    return {
      ok: true,
      engine: "os-ai-computer-use",
      driver: init.driver,
      task,
      stepsCompleted,
    };
  } finally {
    console.log("[test] Stopping desktop control session...");
    await desktopControl.stopControl();
  }
}

runLongChromeTaskTest()
  .then((res) => {
    console.log("[test] SUMMARY:", JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("[test] ❌ Long task backend test failed:", err);
    process.exit(1);
  });
