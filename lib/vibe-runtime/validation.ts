import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import type { ValidationEvidence } from "./runtime";

type PackageJson = { scripts?: Record<string, string> };

async function collectJavaScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...await collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 120_000) {
  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const push = (value: Buffer) => { output = `${output}${value.toString()}`.slice(-24_000); };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: typeof code === "number" ? code : 1, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: error.message });
    });
  });
}

export async function runWorkspaceValidation(workspacePath: string): Promise<ValidationEvidence[]> {
  const startedAt = new Date().toISOString();
  const packagePath = path.join(workspacePath, "package.json");
  if (!existsSync(packagePath)) {
    const indexPath = path.join(workspacePath, "index.html");
    if (!existsSync(indexPath)) {
      return [{ name: "static HTML entry", status: "failed", output: "No package.json or index.html is present.", startedAt, completedAt: new Date().toISOString() }];
    }

    const evidence: ValidationEvidence[] = [{
      name: "static HTML entry",
      command: "index.html",
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
    }];
    const sourceFiles = await collectJavaScriptFiles(workspacePath);
    for (const sourceFile of sourceFiles) {
      const checkStarted = new Date().toISOString();
      const relativePath = path.relative(workspacePath, sourceFile);
      const result = await run("node", ["--check", relativePath], workspacePath);
      evidence.push({
        name: `syntax ${relativePath}`,
        command: `node --check ${relativePath}`,
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        output: result.output,
        startedAt: checkStarted,
        completedAt: new Date().toISOString(),
      });
      if (result.exitCode !== 0) break;
    }
    return evidence;
  }
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8")) as PackageJson;
  const names = ["lint", "typecheck", "test", "build"].filter((name) => Boolean(pkg.scripts?.[name]));
  if (!names.length) {
    return [{ name: "package scripts", status: "skipped", output: "No lint, typecheck, test, or build scripts were declared.", startedAt, completedAt: new Date().toISOString() }];
  }
  const evidence: ValidationEvidence[] = [];
  for (const name of names) {
    const checkStarted = new Date().toISOString();
    const result = await run("npm", ["run", name], workspacePath);
    evidence.push({
      name,
      command: `npm run ${name}`,
      status: result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      output: result.output,
      startedAt: checkStarted,
      completedAt: new Date().toISOString(),
    });
    if (result.exitCode !== 0) break;
  }
  return evidence;
}
