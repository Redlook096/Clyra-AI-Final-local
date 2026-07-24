import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";
import { clyraDataPath } from "../runtime-paths";

export type AgentRuntimeState =
  | "CREATED"
  | "INITIALISING"
  | "INSPECTING"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "RUNNING"
  | "AWAITING_TOOL_APPROVAL"
  | "PAUSED"
  | "VALIDATING"
  | "REPAIRING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED"
  | "INCOMPLETE";

export type AgentRuntimeEventType =
  | "thread.created"
  | "thread.restored"
  | "turn.started"
  | "turn.steered"
  | "plan.created"
  | "plan.updated"
  | "plan.step.started"
  | "plan.step.completed"
  | "tool.requested"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "file.change.proposed"
  | "file.change.applied"
  | "file.diff.updated"
  | "command.started"
  | "command.output"
  | "command.completed"
  | "browser.action.started"
  | "browser.action.completed"
  | "browser.snapshot"
  | "browser.console"
  | "browser.network"
  | "approval.requested"
  | "approval.resolved"
  | "validation.started"
  | "validation.result"
  | "repair.started"
  | "checkpoint.created"
  | "task.paused"
  | "task.resumed"
  | "task.cancelled"
  | "turn.completed"
  | "turn.failed";

export type AgentRuntimeEvent = {
  id: string;
  sequence: number;
  type: AgentRuntimeEventType;
  threadId: string;
  turnId?: string;
  projectId: string;
  timestamp: string;
  harness: "m1" | "openhands" | "cline" | "clyra";
  status: "started" | "progress" | "completed" | "failed" | "info";
  payload: Record<string, unknown>;
  parentId?: string;
  durationMs?: number;
  error?: { code: string; message: string; recoverable?: boolean };
};

export type ValidationEvidence = {
  name: string;
  command?: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  output?: string;
  startedAt: string;
  completedAt: string;
};

export type AgentRuntimeSnapshot = {
  version: 1;
  projectId: string;
  threadId: string;
  turnId?: string;
  state: AgentRuntimeState;
  stateReason?: string;
  sequence: number;
  workspacePath: string;
  workspaceAlias: string;
  harness: "m1" | "openhands" | "cline" | "clyra";
  createdAt: string;
  updatedAt: string;
  validation: ValidationEvidence[];
  completionEvidence: string[];
  checkpointId?: string;
  conversationId?: string;
  error?: { code: string; message: string; recoverable?: boolean };
};

type RuntimeEventInput = Omit<AgentRuntimeEvent, "id" | "sequence" | "threadId" | "turnId" | "projectId" | "timestamp"> &
  Partial<Pick<AgentRuntimeEvent, "turnId" | "parentId" | "durationMs" | "error">>;

const terminalStates = new Set<AgentRuntimeState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
  "INCOMPLETE",
]);

const validTransitions: Record<AgentRuntimeState, AgentRuntimeState[]> = {
  CREATED: ["INITIALISING", "CANCELLED"],
  INITIALISING: ["INSPECTING", "PLANNING", "RUNNING", "FAILED", "CANCELLED", "INTERRUPTED"],
  INSPECTING: ["PLANNING", "RUNNING", "PAUSED", "FAILED", "CANCELLED", "INTERRUPTED"],
  PLANNING: ["AWAITING_PLAN_APPROVAL", "RUNNING", "PAUSED", "FAILED", "CANCELLED", "INTERRUPTED"],
  AWAITING_PLAN_APPROVAL: ["RUNNING", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"],
  RUNNING: ["AWAITING_TOOL_APPROVAL", "PAUSED", "VALIDATING", "REPAIRING", "FAILED", "CANCELLED", "INTERRUPTED", "INCOMPLETE"],
  AWAITING_TOOL_APPROVAL: ["RUNNING", "PAUSED", "CANCELLED", "FAILED", "INTERRUPTED"],
  PAUSED: ["RUNNING", "AWAITING_PLAN_APPROVAL", "CANCELLED", "FAILED", "INTERRUPTED"],
  VALIDATING: ["REPAIRING", "COMPLETED", "FAILED", "INCOMPLETE", "CANCELLED", "INTERRUPTED"],
  REPAIRING: ["RUNNING", "VALIDATING", "FAILED", "INCOMPLETE", "CANCELLED", "INTERRUPTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
  INCOMPLETE: [],
};

function runtimeDirectory(projectRoot: string) {
  // M1 owns `.agent` in generated workspaces and may recreate it while
  // executing. Keep Clyra's append-only runtime sidecar separate so an agent
  // cannot erase its own audit trail, controls, or validation evidence.
  return path.join(projectRoot, ".clyra-runtime", "runtime");
}

function snapshotPath(projectRoot: string) {
  return path.join(runtimeDirectory(projectRoot), "snapshot.json");
}

function eventsPath(projectRoot: string) {
  return path.join(runtimeDirectory(projectRoot), "events.jsonl");
}

function safeProjectSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function runtimeWorkspaceAlias(projectId: string) {
  return clyraDataPath(".clyra", "vibe-runtime", "workspaces", safeProjectSegment(projectId));
}

export async function ensureWorkspaceAlias(projectId: string, workspacePath: string) {
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const alias = runtimeWorkspaceAlias(projectId);
  await fs.mkdir(path.dirname(alias), { recursive: true });
  try {
    const stat = await fs.lstat(alias);
    if (stat.isSymbolicLink()) {
      try {
        const existing = await fs.realpath(alias);
        if (existing === canonicalWorkspace) return alias;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.unlink(alias);
    } else {
      throw new Error(`Refusing to replace a non-symlink workspace alias: ${alias}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.symlink(canonicalWorkspace, alias, "dir");
  return alias;
}

export async function assertWorkspaceBoundary(workspacePath: string, candidate: string) {
  const root = await fs.realpath(workspacePath);
  const resolved = path.resolve(candidate);
  let canonical = resolved;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    const parent = await fs.realpath(path.dirname(resolved));
    canonical = path.join(parent, path.basename(resolved));
  }
  const relative = path.relative(root, canonical);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return canonical;
  }
  throw new Error(`Workspace boundary violation: ${candidate}`);
}

async function fileDigest(target: string) {
  const content = await fs.readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

async function collectManifest(root: string, relative = "") : Promise<Array<{ path: string; sha256: string }>> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries) {
    if (["node_modules", ".git", ".agent", ".clyra-runtime"].includes(entry.name)) continue;
    const next = path.join(relative, entry.name);
    const target = path.join(root, next);
    if (entry.isDirectory()) manifest.push(...await collectManifest(root, next));
    else if (entry.isFile()) manifest.push({ path: next, sha256: await fileDigest(target) });
  }
  return manifest.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createWorkspaceCheckpoint(projectRoot: string, workspacePath: string, reason: string) {
  const id = `checkpoint-${Date.now()}-${randomUUID().slice(0, 6)}`;
  // A full project-root workspace contains its runtime sidecar. Store the
  // checkpoint outside that root so Node cannot recursively copy a directory
  // into one of its own descendants.
  const root = clyraDataPath(".clyra", "vibe-runtime", "checkpoints", path.basename(projectRoot), id);
  await fs.mkdir(root, { recursive: true });
  const manifest = await collectManifest(workspacePath);
  await fs.writeFile(path.join(root, "manifest.json"), `${JSON.stringify({ id, reason, createdAt: new Date().toISOString(), manifest }, null, 2)}\n`, "utf8");
  await fs.cp(workspacePath, path.join(root, "files"), {
    recursive: true,
    filter: (source) => !["node_modules", ".clyra-runtime"].some((name) => source.includes(`${path.sep}${name}${path.sep}`)),
  });
  return { id, manifest };
}

export class AgentRuntimeStore {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly projectRoot: string) {}

  private enqueue<T>(operation: () => Promise<T>) {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readSnapshot() {
    const raw = await fs.readFile(snapshotPath(this.projectRoot), "utf8");
    return JSON.parse(raw) as AgentRuntimeSnapshot;
  }

  public async create(input: Omit<AgentRuntimeSnapshot, "version" | "sequence" | "createdAt" | "updatedAt" | "validation" | "completionEvidence">) {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const snapshot: AgentRuntimeSnapshot = {
        ...input,
        version: 1,
        sequence: 0,
        createdAt: now,
        updatedAt: now,
        validation: [],
        completionEvidence: [],
      };
      await fs.mkdir(runtimeDirectory(this.projectRoot), { recursive: true });
      await fs.writeFile(snapshotPath(this.projectRoot), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await fs.writeFile(eventsPath(this.projectRoot), "", "utf8");
      await this.appendToSnapshot(snapshot, { type: "thread.created", harness: input.harness, status: "info", payload: { workspaceAlias: input.workspaceAlias } });
      return snapshot;
    });
  }

  public async getSnapshot() {
    await this.writeChain;
    return this.readSnapshot();
  }

  private async save(snapshot: AgentRuntimeSnapshot) {
    snapshot.updatedAt = new Date().toISOString();
    await fs.writeFile(snapshotPath(this.projectRoot), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  private async appendToSnapshot(snapshot: AgentRuntimeSnapshot, input: RuntimeEventInput) {
    const event: AgentRuntimeEvent = {
      id: randomUUID(),
      sequence: snapshot.sequence + 1,
      type: input.type,
      threadId: snapshot.threadId,
      turnId: input.turnId || snapshot.turnId,
      projectId: snapshot.projectId,
      timestamp: new Date().toISOString(),
      harness: input.harness,
      status: input.status,
      payload: input.payload,
      parentId: input.parentId,
      durationMs: input.durationMs,
      error: input.error,
    };
    await fs.appendFile(eventsPath(this.projectRoot), `${JSON.stringify(event)}\n`, "utf8");
    snapshot.sequence = event.sequence;
    await this.save(snapshot);
    return event;
  }

  public async append(input: RuntimeEventInput) {
    return this.enqueue(async () => this.appendToSnapshot(await this.readSnapshot(), input));
  }

  public async events(afterSequence = 0) {
    await this.writeChain;
    try {
      const raw = await fs.readFile(eventsPath(this.projectRoot), "utf8");
      return raw.split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as AgentRuntimeEvent)
        .filter((event) => event.sequence > afterSequence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public async transition(next: AgentRuntimeState, reason: string, error?: AgentRuntimeSnapshot["error"]) {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      if (snapshot.state !== next && !validTransitions[snapshot.state].includes(next)) {
        throw new Error(`Invalid runtime transition ${snapshot.state} -> ${next}`);
      }
      snapshot.state = next;
      snapshot.stateReason = reason;
      if (error) snapshot.error = error;
      await this.save(snapshot);
      const type: AgentRuntimeEventType = next === "COMPLETED" ? "turn.completed" : (next === "FAILED" || next === "INCOMPLETE" || next === "INTERRUPTED") ? "turn.failed" : next === "PAUSED" ? "task.paused" : next === "CANCELLED" ? "task.cancelled" : "tool.progress";
      await this.appendToSnapshot(snapshot, { type, harness: snapshot.harness, status: error ? "failed" : "progress", payload: { state: next, reason }, error });
      return snapshot;
    });
  }

  public async addValidation(evidence: ValidationEvidence) {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      snapshot.validation.push(evidence);
      await this.save(snapshot);
      await this.appendToSnapshot(snapshot, {
        type: "validation.result",
        harness: snapshot.harness,
        status: evidence.status === "passed" || evidence.status === "skipped" ? "completed" : "failed",
        payload: evidence,
        error: evidence.status === "failed" ? { code: "validation_failed", message: `${evidence.name} failed`, recoverable: true } : undefined,
      });
    });
  }

  public async addCompletionEvidence(evidence: string) {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      if (!snapshot.completionEvidence.includes(evidence)) snapshot.completionEvidence.push(evidence);
      await this.save(snapshot);
    });
  }

  public async setConversation(conversationId: string) {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      snapshot.conversationId = conversationId;
      await this.save(snapshot);
    });
  }

  public async setCheckpoint(checkpointId: string) {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      snapshot.checkpointId = checkpointId;
      await this.save(snapshot);
    });
  }

  public async exists() {
    await this.writeChain;
    try {
      await fs.access(snapshotPath(this.projectRoot), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export function isTerminalRuntimeState(state: AgentRuntimeState) {
  return terminalStates.has(state);
}
