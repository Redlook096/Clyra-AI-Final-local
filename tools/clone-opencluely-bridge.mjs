import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const destination = path.join(root, "apps", "opencluely");
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});

console.warn(`Replacing ${destination} with a fresh OpenCluely clone.`);
await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await run("git", ["clone", "--depth", "1", "https://github.com/TechyCSR/OpenCluely.git", destination]);
await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "opencluely:sync"], { cwd: root });
await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=optional"], { cwd: destination });
console.log("OpenCluely was cloned, synchronized, and installed.");
