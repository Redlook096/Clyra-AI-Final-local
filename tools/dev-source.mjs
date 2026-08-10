import path from "node:path";
import { spawn } from "node:child_process";

const localBin = path.join(process.cwd(), "node_modules", ".bin");
const opencodeBin = path.join(process.env.USERPROFILE || process.env.HOME || "", ".opencode", "bin");
const command = process.platform === "win32" ? "tsx.cmd" : "tsx";
const child = spawn(command, ["server.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: [localBin, opencodeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
  },
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (error) => {
  console.error(`Could not start the source server: ${error.message}`);
  process.exit(1);
});
