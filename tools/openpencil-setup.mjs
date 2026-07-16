import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const OPENPENCIL_COMMIT =
  process.env.OPENPENCIL_COMMIT || "7686be652fee8d4d55c42e75b21ad2199d28a5e5";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const openPencilRoot = path.join(root, ".cache", "openpencil");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: process.env,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `${command} exited with ${result.status}`);
  }
  return String(result.stdout || "").trim();
}

function configDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "openpencil");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "openpencil");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "openpencil");
}

async function provisionModelAdapter() {
  const directory = configDir();
  const filename = path.join(directory, "settings.json");
  await mkdir(directory, { recursive: true });

  let settings = { version: 1 };
  try {
    settings = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    // A fresh local OpenPencil profile is expected on first setup.
  }

  const appPort = process.env.PORT || "3000";
  const baseUrl =
    process.env.OPENPENCIL_CLYRA_API_BASE ||
    `http://127.0.0.1:${appPort}/api/openpencil/v1`;
  const model = process.env.OPENPENCIL_MODEL || "deepseek-chat";
  const configured = {
    id: "clyra-existing-api",
    preset: "custom",
    display_name: "Clyra model",
    kind: "openai-compat",
    // This token authenticates only against the localhost Clyra adapter.
    // The real provider credential never leaves the Clyra server process.
    api_key: "clyra-local-adapter",
    model,
    base_url: baseUrl,
    enabled: true,
  };

  const agents = Array.isArray(settings.builtin_agents)
    ? settings.builtin_agents.filter((agent) => agent?.id !== configured.id)
    : [];
  settings = {
    ...settings,
    version: 1,
    locale: "en-US",
    theme: "light",
    builtin_agents: [configured, ...agents],
  };
  await writeFile(filename, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return filename;
}

export async function setupOpenPencil() {
  if (!existsSync(path.join(openPencilRoot, ".git"))) {
    await mkdir(path.dirname(openPencilRoot), { recursive: true });
    run("git", [
      "clone",
      "--recurse-submodules",
      "https://github.com/ZSeven-W/openpencil.git",
      openPencilRoot,
    ]);
  }

  const current = run("git", ["rev-parse", "HEAD"], {
    cwd: openPencilRoot,
    quiet: true,
  });
  if (current !== OPENPENCIL_COMMIT) {
    run("git", ["fetch", "origin", OPENPENCIL_COMMIT, "--depth", "1"], {
      cwd: openPencilRoot,
    });
    run("git", ["checkout", "--detach", OPENPENCIL_COMMIT], {
      cwd: openPencilRoot,
    });
  }
  run("git", ["submodule", "sync", "--recursive"], { cwd: openPencilRoot });
  run("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: openPencilRoot,
  });

  const settingsPath = await provisionModelAdapter();
  return { root: openPencilRoot, commit: OPENPENCIL_COMMIT, settingsPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupOpenPencil()
    .then(({ root: source, commit, settingsPath }) => {
      process.stdout.write(
        `OpenPencil ${commit.slice(0, 12)} is ready at ${source}\nModel adapter: ${settingsPath}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
