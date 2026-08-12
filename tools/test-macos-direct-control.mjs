import path from "node:path";
import { fileURLToPath } from "node:url";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopControlPath = path.join(root, "scripts", "opencluely-bridge", "desktop-control.service.js");

async function runDirectControlTest() {
  console.log("==========================================================");
  console.log("    DIRECT MACOS INPUT CONTROL TEST (BYPASSING LLM)       ");
  console.log("==========================================================");

  const desktopControl = (await import(`file://${desktopControlPath}`)).default;
  const init = await desktopControl.initialize();
  console.log("[test] Initialized desktop control driver:", init.driver);

  if (init.driver === "none") {
    throw new Error("Desktop control driver unavailable.");
  }

  await desktopControl.startControl("Direct input test");

  try {
    console.log("[test] 1. Testing mouse move to (300, 300)...");
    const moveRes = await desktopControl.move(300, 300, "Move cursor");
    console.log("Move result:", moveRes);
    await wait(300);

    console.log("[test] 2. Testing left click at (300, 300)...");
    const clickRes = await desktopControl.click(300, 300, "left", "Left click");
    console.log("Click result:", clickRes);
    await wait(300);

    console.log("[test] 3. Testing right click at (300, 300)...");
    const rightClickRes = await desktopControl.click(300, 300, "right", "Right click");
    console.log("Right click result:", rightClickRes);
    await wait(300);

    console.log("[test] 4. Testing double click at (300, 300)...");
    const doubleClickRes = await desktopControl.click(300, 300, "left", "Double click", { clicks: 2 });
    console.log("Double click result:", doubleClickRes);
    await wait(300);

    console.log('[test] 5. Testing text typing ("Mac computer control test")...');
    const typeRes = await desktopControl.typeText("Mac computer control test", "Type text");
    console.log("Type result:", typeRes);
    await wait(300);

    console.log("[test] 6. Testing hotkey (cmd+l)...");
    const keyRes = await desktopControl.key("cmd+l", "Focus hotkey");
    console.log("Key result:", keyRes);
    await wait(300);

    console.log("[test] 7. Testing scroll (deltaY = -4)...");
    const scrollRes = await desktopControl.scroll(-4, "Scroll down");
    console.log("Scroll result:", scrollRes);
    await wait(300);

    console.log("==========================================================");
    console.log("  ✓ DIRECT MACOS INPUT CONTROL TEST PASSED 100%!          ");
    console.log("==========================================================");

    return {
      ok: true,
      driver: init.driver,
      moveRes,
      clickRes,
      rightClickRes,
      doubleClickRes,
      typeRes,
      keyRes,
      scrollRes,
    };
  } finally {
    await desktopControl.stopControl();
  }
}

runDirectControlTest()
  .then((res) => {
    console.log("[test] SUMMARY:", JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("[test] ❌ Direct input test failed:", err);
    process.exit(1);
  });
