import { spawn } from "node:child_process";
import process from "node:process";

const children = [
  spawn("npm", ["run", "dev:source"], { stdio: "inherit", env: process.env }),
  spawn("npm", ["run", "dev:openpencil"], { stdio: "inherit", env: process.env }),
];

let stopping = false;
const stopAll = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

for (const child of children) {
  child.once("exit", (code, signal) => {
    if (stopping) return;
    stopAll(signal || "SIGTERM");
    process.exitCode = code ?? 1;
  });
}
