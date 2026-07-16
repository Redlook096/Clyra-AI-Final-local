import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { openPencilRoot, setupOpenPencil } from "./openpencil-setup.mjs";

function commandExists(command) {
  const paths = String(process.env.PATH || "").split(path.delimiter);
  return paths.some((directory) => existsSync(path.join(directory, command)));
}

try {
  await setupOpenPencil();

  const missing = ["cargo", "wasm-bindgen", "wasm-opt", "node", "gzip"].filter(
    (command) => !commandExists(command),
  );
  if (missing.length) {
    throw new Error(
      `OpenPencil is missing local build tools: ${missing.join(", ")}. Run npm run check:openpencil for repair guidance.`,
    );
  }

  const wasmBundle = path.join(
    openPencilRoot,
    "crates",
    "op-host-web",
    "pkg",
    "op_host_web_bg.wasm",
  );
  const serverBinary = path.join(
    openPencilRoot,
    "target",
    "release",
    "op-host-web-server",
  );

  const child = spawn("bash", ["scripts/start-web-rust.sh"], {
    cwd: openPencilRoot,
    env: {
      ...process.env,
      OPENPENCIL_SERVE_HOST: process.env.OPENPENCIL_HOST || "127.0.0.1",
      OPENPENCIL_SERVE_PORT: process.env.OPENPENCIL_PORT || "3100",
      OPENPENCIL_SKIP_WASM_BUILD: existsSync(wasmBundle) ? "1" : "0",
      OPENPENCIL_SKIP_SERVER_BUILD: existsSync(serverBinary) ? "1" : "0",
      OPENPENCIL_VISION_VALIDATION: "0",
    },
    stdio: "inherit",
  });

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
