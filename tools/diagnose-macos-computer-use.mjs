import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const macosInputPy = path.join(root, "scripts", "opencluely-bridge", "macos-input.py");

async function diagnose() {
  console.log("==========================================================");
  console.log("          macOS COMPUTER CONTROL DIAGNOSTIC               ");
  console.log("==========================================================");
  console.log(`Executable: ${process.execPath}`);
  console.log(`PID: ${process.pid}`);
  console.log(`Platform: ${process.platform} (${process.arch})`);

  let pythonPath = "python3";
  try {
    const { stdout } = await execFileAsync("which", ["python3"]);
    pythonPath = stdout.trim();
  } catch {
    /* fallback */
  }

  console.log(`Python: ${pythonPath}`);

  let pyDiag = null;
  try {
    const { stdout } = await execFileAsync(pythonPath, [macosInputPy, "diagnose"]);
    pyDiag = JSON.parse(stdout.trim());
  } catch (err) {
    pyDiag = { error: err.message };
  }

  const trusted = pyDiag?.accessibility_granted ?? false;
  console.log(`Driver: ${pyDiag?.driver || "QuartzMacOSDriver"}`);
  console.log(`Accessibility Granted: ${trusted ? "✓ YES (GRANTED)" : "✗ NO (DENIED)"}`);

  if (!trusted) {
    console.log("\n⚠️ ACTION REQUIRED:");
    console.log("macOS Accessibility permission is not enabled for the process executing automation.");
    console.log("Enable permission in:");
    console.log("  System Settings -> Privacy & Security -> Accessibility");
    console.log(`  For executable: ${process.execPath} and ${pythonPath}`);
  } else {
    console.log("\n✓ All macOS Quartz input automation drivers are operational.");
  }

  return { ok: trusted, details: pyDiag };
}

diagnose()
  .then((res) => {
    console.log("==========================================================");
    process.exit(res.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("Diagnostic error:", err);
    process.exit(1);
  });
