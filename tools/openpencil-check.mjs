import { spawnSync } from "node:child_process";
import process from "node:process";
import { setupOpenPencil } from "./openpencil-setup.mjs";

function version(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0
    ? String(result.stdout || result.stderr).trim()
    : "missing";
}

const setup = await setupOpenPencil();
const checks = {
  rustc: version("rustc"),
  cargo: version("cargo"),
  node: version("node"),
  bun: version("bun"),
  "wasm-bindgen": version("wasm-bindgen"),
  "wasm-opt": version("wasm-opt"),
  "wasm32 target": version("rustup", ["target", "list", "--installed"])
    .split("\n")
    .includes("wasm32-unknown-unknown")
    ? "installed"
    : "missing",
};

for (const [name, result] of Object.entries(checks)) {
  process.stdout.write(`${name.padEnd(16)} ${result}\n`);
}
process.stdout.write(`source           ${setup.root}\ncommit           ${setup.commit}\n`);

if (Object.values(checks).includes("missing")) {
  process.stderr.write(
    "Repair: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --locked; brew install binaryen\n",
  );
  process.exitCode = 1;
}
