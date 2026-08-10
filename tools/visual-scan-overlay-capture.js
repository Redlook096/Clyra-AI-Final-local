/**
 * Capture NameDrop liquid-wave frames from the real Electron overlay via capturePage.
 * Run:  cd apps/opencluely && ./node_modules/.bin/electron ../../tools/visual-scan-overlay-capture.js
 * Or:   npm run opencluely:clone && node -e '...' 
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const svcPath = path.join(__dirname, "../apps/opencluely/src/services/visual-scan/visual-scan.service.js");
const { VisualScanService } = require(svcPath);

const out = path.join(process.env.HOME, ".cursor/artifacts/namedrop-wave-overlay");
fs.mkdirSync(out, { recursive: true });

app.whenReady().then(async () => {
  const svc = new VisualScanService({ logger: console });
  const result = await svc.start({ reason: "overlay-capture", force: true, durationMs: 30000 });
  console.log("start", result);

  for (let i = 0; i < 120; i++) {
    if (svc.overlay && !svc.overlay.isDestroyed()) {
      const ready = await svc.overlay.webContents
        .executeJavaScript(
          "typeof window.__seekVisualScan === 'function' && window.__glHasTex === true",
          true,
        )
        .catch(() => false);
      if (ready) {
        console.log("overlay ready at", i);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!svc.overlay || svc.overlay.isDestroyed()) {
    console.error("overlay missing");
    app.exit(1);
    return;
  }

  const meta = await svc.overlay.webContents.executeJavaScript(
    `({ hasTex: !!window.__glHasTex, seek: typeof window.__seekVisualScan })`,
    true,
  );
  console.log("meta", meta);

  const progresses = [0.02, 0.06, 0.1, 0.16, 0.22, 0.3, 0.4, 0.55, 0.75];
  for (let i = 0; i < progresses.length; i++) {
    const p = progresses[i];
    await svc.overlay.webContents.executeJavaScript(`window.__seekVisualScan(${p});`, true);
    await new Promise((r) => setTimeout(r, 50));
    const img = await svc.overlay.capturePage();
    const dest = path.join(out, `seek-${String(i + 1).padStart(2, "0")}-p${Math.round(p * 100)}.png`);
    fs.writeFileSync(dest, img.toPNG());
    console.log("wrote", dest, img.getSize());
  }

  const shots = path.join(process.env.HOME, ".cursor/artifacts/screenshots");
  fs.mkdirSync(shots, { recursive: true });
  for (const f of fs.readdirSync(out)) {
    if (f.startsWith("seek-")) {
      fs.copyFileSync(path.join(out, f), path.join(shots, f));
    }
  }

  await svc.stop();
  app.exit(0);
});
