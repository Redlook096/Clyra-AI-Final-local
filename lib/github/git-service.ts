import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as git from "isomorphic-git";

export type GitFileStatus = "A" | "M" | "D" | "R" | "?";

export type GitProjectStatus = {
  initialized: boolean;
  branch: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; status: GitFileStatus; staged: boolean }>;
};

const DEFAULT_GITIGNORE = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".env",
  ".env.*",
  "!.env.example",
  ".DS_Store",
  "*.log",
  ".clyra-attachments/",
].join("\n") + "\n";

function assertRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.split("/").includes("..") || path.isAbsolute(value)) {
    throw new Error("Invalid repository path.");
  }
  return normalized;
}

async function exists(file: string) {
  try { await fsp.access(file); return true; } catch { return false; }
}

async function ensureGitignore(dir: string) {
  const file = path.join(dir, ".gitignore");
  if (!await exists(file)) {
    await fsp.writeFile(file, DEFAULT_GITIGNORE, "utf8");
    return;
  }
  const current = await fsp.readFile(file, "utf8");
  const additions = DEFAULT_GITIGNORE.split("\n").filter((entry) => entry && !current.split(/\r?\n/).includes(entry));
  if (additions.length) await fsp.appendFile(file, `${current.endsWith("\n") ? "" : "\n"}${additions.join("\n")}\n`, "utf8");
}

function gitStatus(row: [number, number, number]): GitFileStatus | null {
  const [head, workdir, stage] = row;
  // isomorphic-git uses 0 absent, 1 unchanged/present and 2 changed. A
  // clean tracked file is [1, 1, 1]—treating "1" as modified would make an
  // entire repository appear dirty immediately after every commit.
  if (head === workdir && workdir === stage) return null;
  if (head === 0 && workdir === 2) return "A";
  if (workdir === 0) return "D";
  if (head !== workdir || head !== stage) return "M";
  return "?";
}

export class GitService {
  async status(dir: string): Promise<GitProjectStatus> {
    if (!await exists(path.join(dir, ".git"))) {
      return { initialized: false, branch: null, remoteUrl: null, ahead: 0, behind: 0, changes: [] };
    }
    const [branch, remoteUrl, matrix] = await Promise.all([
      git.currentBranch({ fs, dir, fullname: false }).catch(() => null),
      git.getConfig({ fs, dir, path: "remote.origin.url" }).catch(() => undefined),
      git.statusMatrix({ fs, dir }),
    ]);
    const changes = matrix.flatMap(([file, head, workdir, stage]) => {
      const status = gitStatus([head, workdir, stage]);
      if (!status) return [];
      return [{ path: file, status, staged: stage !== head }];
    });
    return { initialized: true, branch: branch ?? "main", remoteUrl: remoteUrl ?? null, ahead: 0, behind: 0, changes };
  }

  async init(dir: string) {
    await fsp.mkdir(dir, { recursive: true });
    await ensureGitignore(dir);
    if (!await exists(path.join(dir, ".git"))) await git.init({ fs, dir, defaultBranch: "main" });
    return this.status(dir);
  }

  async stage(dir: string, file: string, staged: boolean) {
    const filepath = assertRelativePath(file);
    if (staged) await git.add({ fs, dir, filepath });
    else await git.resetIndex({ fs, dir, filepath });
    return this.status(dir);
  }

  async stageAll(dir: string) {
    await this.init(dir);
    const matrix = await git.statusMatrix({ fs, dir });
    for (const [filepath, head, workdir] of matrix) {
      if (workdir === 0 && head === 1) await git.remove({ fs, dir, filepath });
      else if (workdir !== 0) await git.add({ fs, dir, filepath });
    }
    return this.status(dir);
  }

  async commit(dir: string, message: string, author: { name: string; email: string }) {
    await this.stageAll(dir);
    const status = await this.status(dir);
    if (!status.changes.some((change) => change.staged)) throw new Error("There are no staged changes to commit.");
    const oid = await git.commit({ fs, dir, message: message.trim() || "Update project", author });
    return { oid, status: await this.status(dir) };
  }

  async branches(dir: string) {
    if (!await exists(path.join(dir, ".git"))) return { current: null, branches: [] as string[] };
    const [current, branches] = await Promise.all([
      git.currentBranch({ fs, dir, fullname: false }).catch(() => null),
      git.listBranches({ fs, dir }),
    ]);
    return { current, branches };
  }

  async createBranch(dir: string, branch: string) {
    const ref = branch.trim().replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/^[-/]+|[-/]+$/g, "");
    if (!ref) throw new Error("Enter a valid branch name.");
    await git.branch({ fs, dir, ref });
    await git.checkout({ fs, dir, ref });
    return this.branches(dir);
  }

  async checkout(dir: string, branch: string) {
    await git.checkout({ fs, dir, ref: branch });
    return this.branches(dir);
  }
}

export const gitService = new GitService();
