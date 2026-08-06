/**
 * Screen capture for Clyra Screen Companion.
 * Adapted from OpenCluely's capture.service.js API shape (MIT) — no stealth.
 * Capture is explicit / user-visible and returns an evidence receipt.
 */
import { desktopCapturer, screen } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export class ScreenCaptureService {
  constructor() {
    this.isProcessing = false;
    this.lastCapture = null;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map((display) => ({
        id: display.id,
        bounds: display.bounds,
        size: display.size,
        scaleFactor: display.scaleFactor,
        primary: display.id === screen.getPrimaryDisplay().id,
      }));
      return { ok: true, displays };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * @param {{ displayId?: number, maxWidth?: number, jpegQuality?: number }} options
   */
  async capture(options = {}) {
    if (this.isProcessing) throw new Error("Capture already in progress");
    this.isProcessing = true;
    const started = Date.now();
    try {
      const target = this.#targetDisplay(options.displayId);
      const maxWidth = Math.max(640, Math.min(1600, Number(options.maxWidth) || 1280));
      const scale = Math.min(1, maxWidth / Math.max(1, target.size.width));
      const width = Math.round(target.size.width * scale);
      const height = Math.round(target.size.height * scale);

      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
      });
      if (!sources.length) throw new Error("No screen sources available");

      let source = sources[0];
      const match = sources.find((candidate) => {
        const size = candidate.thumbnail.getSize();
        return Math.abs(size.width - width) < 8 && Math.abs(size.height - height) < 8;
      });
      if (match) source = match;

      const image = source.thumbnail;
      if (!image || image.isEmpty()) throw new Error("Failed to capture screen thumbnail");

      const jpegQuality = Math.max(40, Math.min(90, Number(options.jpegQuality) || 72));
      const buffer = image.toJPEG(jpegQuality);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clyra-companion-"));
      const filePath = path.join(dir, `screen-${Date.now()}.jpg`);
      await fs.writeFile(filePath, buffer);

      const receipt = {
        ok: true,
        path: filePath,
        mimeType: "image/jpeg",
        bytes: buffer.length,
        displayId: target.id,
        sourceName: source.name,
        dimensions: image.getSize(),
        scaleFactor: target.scaleFactor,
        bounds: target.bounds,
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        retention: "ephemeral-session",
        permission: "user-granted-session",
      };
      this.lastCapture = receipt;
      return receipt;
    } finally {
      this.isProcessing = false;
    }
  }

  #targetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all.length) return screen.getPrimaryDisplay();
    if (displayId == null) return screen.getPrimaryDisplay();
    return all.find((display) => display.id === displayId) || screen.getPrimaryDisplay();
  }
}
