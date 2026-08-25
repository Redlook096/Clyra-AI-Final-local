/**
 * Live MJPEG stream from a booted Simulator via `sim-use stream-video`.
 * This is the Intel-safe streaming path (no native Apple-Silicon-only addon
 * involved, unlike serve-sim) and works identically on Apple Silicon.
 *
 * `sim-use stream-video --format mjpeg` writes a complete raw HTTP/1.1
 * response (status line + headers + multipart body) straight to stdout —
 * confirmed from its source (Sources/iOSSimBackend/Verbs/IOSSimStreamVideoCommand.swift):
 * boundary token is the literal string "--mjpegstream". We strip its
 * self-written header (up to the first blank line) and re-emit our own
 * equivalent header on the real Express response, then pipe the remaining
 * multipart body straight through unmodified.
 */
import type { Response } from "express";
import { spawn } from "node:child_process";
import { resolveBin } from "./host";

const MJPEG_BOUNDARY = "--mjpegstream";

export async function pipeMjpegStream(udid: string, res: Response, opts?: { fps?: number; quality?: number }) {
  const bin = await resolveBin("sim-use");
  if (!bin) {
    res.status(503).json({ error: "sim-use is not installed on this Apple Host." });
    return;
  }
  const child = spawn(bin, [
    "stream-video", "--device", udid, "--format", "mjpeg",
    "--fps", String(opts?.fps ?? 15), "--quality", String(opts?.quality ?? 80),
  ]);

  let headerStripped = false;
  let headerSent = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (!headerStripped) {
      const text = chunk.toString("latin1");
      const splitAt = text.indexOf("\r\n\r\n");
      if (splitAt === -1) return; // still buffering the header
      headerStripped = true;
      const body = chunk.subarray(Buffer.byteLength(text.slice(0, splitAt + 4), "latin1"));
      if (!headerSent) {
        headerSent = true;
        res.writeHead(200, {
          "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
      }
      if (body.length) res.write(body);
      return;
    }
    res.write(chunk);
  });
  child.stderr.on("data", () => undefined);
  child.once("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "sim-use stream-video failed to start." });
    else res.end();
  });
  child.once("exit", () => {
    if (!res.writableEnded) res.end();
  });
  res.once("close", () => child.kill());
}
